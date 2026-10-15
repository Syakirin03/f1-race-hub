#!/usr/bin/env python3
"""
F1 data warehouse build:  data/*.csv (1950-2024)  +  data/f1.db (live seasons)  ->  data/warehouse.db

Layers
  raw_*    bronze  the CSV files exactly as delivered (every column TEXT), for lineage
  dim_*    silver  cleaned, typed, conformed dimensions        (schema.sql)
  fct_*    silver  cleaned facts: results, laps, stops, ...    (transform_*.sql, finalize.sql)
  ml_*     gold    leakage-safe ML feature table              (ml_features.sql)
  dq_log           what the cleaning changed + integrity checks

    python warehouse/build_warehouse.py

A full rebuild every time (about a minute): the source files are the truth,
and the warehouse can always be regenerated from them.
"""
from __future__ import annotations

import csv
import re
import sqlite3
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
WAREHOUSE = DATA / "warehouse.db"
LIVE_DB = DATA / "f1.db"
NULL_MARKERS = {"\\N", ""}

CSV_TABLES = ["seasons", "circuits", "drivers", "constructors", "status", "races", "results",
              "sprint_results", "qualifying", "lap_times", "pit_stops", "driver_standings",
              "constructor_standings", "constructor_results"]


# ---------------------------------------------------------------------------
# Cleaning helpers, registered as SQL functions
# ---------------------------------------------------------------------------
def clean(v):
    """Trim text and turn the dump's null markers into real NULLs."""
    if v is None:
        return None
    v = str(v).strip()
    return None if v in NULL_MARKERS else v


def to_ms(text):
    """'1:26.572' -> 86572, '26.898' -> 26898, '1:34:50.616' -> 5690616."""
    text = clean(text)
    if text is None:
        return None
    try:
        secs = 0.0
        for part in text.split(":"):
            secs = secs * 60 + float(part)
        return round(secs * 1000)
    except ValueError:
        return None


def status_category(status):
    s = (status or "").strip().lower()
    if s == "finished":
        return "finished"
    if s == "lapped" or re.fullmatch(r"\+\d+ laps?", s):
        return "lapped"
    if s in ("disqualified", "excluded", "underweight"):
        return "disqualified"
    if s in ("did not qualify", "did not prequalify", "107% rule"):
        return "did_not_qualify"
    if s in ("did not start", "withdrew"):
        return "did_not_start"
    if s in ("accident", "collision", "collision damage", "spun off", "fatal accident", "damage", "debris"):
        return "accident"
    if s in ("physical", "injured", "injury", "driver unwell", "eye injury", "illness"):
        return "driver"
    if s in ("retired", "not classified", "not restarted", "safety concerns"):
        return "retired_other"
    return "mechanical"   # engine, gearbox, hydraulics, ... (about 100 statuses)


class Median:
    """SQL aggregate: median(x), ignoring NULLs."""
    def __init__(self):
        self.values = []

    def step(self, x):
        if x is not None:
            self.values.append(x)

    def finalize(self):
        return statistics.median(self.values) if self.values else None


# ---------------------------------------------------------------------------
# Build steps
# ---------------------------------------------------------------------------
class DQ:
    def __init__(self):
        self.rows = []

    def log(self, step, check, rows, note=""):
        self.rows.append((step, check, rows, note))

    def save(self, db):
        db.executemany("INSERT INTO dq_log (step, check_, rows, note) VALUES (?, ?, ?, ?)", self.rows)


def run_sql(db, name, params=None):
    """Run a .sql file one statement at a time (so named parameters work)."""
    stmt = ""
    for line in (HERE / name).read_text(encoding="utf-8").splitlines(keepends=True):
        stmt += line
        if sqlite3.complete_statement(stmt):
            if stmt.strip():
                db.execute(stmt, params or {})
            stmt = ""


def load_raw(db, dq):
    """Bronze: every CSV into raw_<name> exactly as delivered."""
    for name in CSV_TABLES:
        path = DATA / f"{name}.csv"
        with open(path, newline="", encoding="utf-8") as fh:
            reader = csv.reader(fh)
            header = next(reader)
            cols = ", ".join(f'"{h}" TEXT' for h in header)
            db.execute(f"CREATE TABLE raw_{name} ({cols})")
            db.executemany(f"INSERT INTO raw_{name} VALUES ({', '.join('?' * len(header))})", reader)
        n = db.execute(f"SELECT COUNT(*) FROM raw_{name}").fetchone()[0]
        dq.log("raw", f"{name}.csv loaded", n)
        # profile what the clean step will change
        nulls = spaces = 0
        for h in header:
            a, b = db.execute(f'SELECT SUM(TRIM("{h}") IN (\'\\N\', \'\')), SUM("{h}" <> TRIM("{h}")) '
                              f"FROM raw_{name}").fetchone()
            nulls += a or 0
            spaces += b or 0
        if nulls:
            dq.log("clean", f"{name}: null markers (\\N or empty) -> NULL", nulls)
        if spaces:
            dq.log("clean", f"{name}: values with stray whitespace trimmed", spaces)


def quality_report(db, dq, csv_max):
    q = lambda sql: db.execute(sql).fetchone()[0]
    dq.log("clean", "results: shared drives flagged (excluded from ML)",
           q("SELECT COUNT(*) FROM fct_result WHERE is_shared_drive = 1"), "1950s-70s shared cars")
    dq.log("clean", "results: grid 0 -> pit-lane start", q("SELECT COUNT(*) FROM fct_result WHERE is_pitlane_start = 1"))
    dq.log("clean", "results: grid 0 -> did not start (grid set NULL)",
           q("SELECT COUNT(*) FROM fct_result WHERE grid_raw = 0 AND did_start = 0"))
    dq.log("clean", "results: era points re-scored to 25-18-15... (points_std)",
           q("SELECT COUNT(*) FROM fct_result WHERE points <> points_std"), "rows where the era's points differ")
    dq.log("clean", "qualifying: times that couldn't be parsed",
           q("SELECT COUNT(*) FROM raw_qualifying WHERE TRIM(q1) NOT IN ('\\N','') AND q1 NOT LIKE '%:%.%'"))
    dq.log("clean", "laps: extreme laps flagged (> 2x race median)", q("SELECT COUNT(*) FROM fct_lap WHERE is_extreme_lap"))
    dq.log("clean", "laps: green-flag racing laps flagged", q("SELECT COUNT(*) FROM fct_lap WHERE is_green_lap"))
    dq.log("clean", "pit stops: long stops flagged (> 2 min)", q("SELECT COUNT(*) FROM fct_pit_stop WHERE is_long_stop"))
    for cat, n in db.execute("SELECT category, COUNT(*) FROM dim_status GROUP BY category ORDER BY 2 DESC"):
        dq.log("clean", f"status category '{cat}'", n, "statuses grouped")
    for table in ("dim_race", "fct_result", "fct_qualifying", "fct_pit_stop", "fct_driver_standing"):
        n = q(f"SELECT COUNT(*) FROM {table} WHERE "
              + ("source = 'live'" if table in ("dim_race", "fct_result", "fct_qualifying")
                 else f"race_key IN (SELECT race_key FROM dim_race WHERE source = 'live')"))
        dq.log("live", f"{table}: rows from f1.db (seasons > {csv_max})", n)
    dq.log("live", "fct_lap: rows from f1.db",
           q("SELECT COUNT(*) FROM fct_lap WHERE race_key IN (SELECT race_key FROM dim_race WHERE source = 'live')"))
    for dim, raw in (("dim_driver", "drivers"), ("dim_constructor", "constructors"),
                     ("dim_circuit", "circuits"), ("dim_status", "status")):
        dq.log("live", f"{dim}: new entities added from f1.db",
               q(f"SELECT COUNT(*) FROM {dim}") - q(f"SELECT COUNT(*) FROM raw_{raw}"))
    # integrity
    fk = db.execute("PRAGMA foreign_key_check").fetchall()
    dq.log("integrity", "foreign-key violations", len(fk), "must be 0")
    dq.log("integrity", "laps without a race result for that driver",
           q("SELECT COUNT(*) FROM (SELECT DISTINCT race_key, driver_key FROM fct_lap) l "
             "WHERE NOT EXISTS (SELECT 1 FROM fct_result r WHERE r.race_key = l.race_key AND r.driver_key = l.driver_key)"))
    dq.log("integrity", "races without results", q(
        "SELECT COUNT(*) FROM dim_race x WHERE x.race_date <= date('now') "
        "AND NOT EXISTS (SELECT 1 FROM fct_result r WHERE r.race_key = x.race_key)"), "past races only")
    dq.log("integrity", "seasons missing between history and live data", q(
        "WITH RECURSIVE y(s) AS (SELECT MIN(season) FROM dim_season UNION ALL SELECT s + 1 FROM y "
        "WHERE s < (SELECT MAX(season) FROM dim_season)) SELECT COUNT(*) FROM y WHERE s NOT IN (SELECT season FROM dim_season)"))
    return fk


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    started = time.monotonic()
    tmp = WAREHOUSE.with_suffix(".db.building")
    tmp.unlink(missing_ok=True)
    db = sqlite3.connect(tmp)
    db.execute("PRAGMA journal_mode = OFF")      # a throwaway file until the build succeeds
    db.execute("PRAGMA synchronous = OFF")
    db.create_function("clean", 1, clean, deterministic=True)
    db.create_function("to_ms", 1, to_ms, deterministic=True)
    db.create_function("status_category", 1, status_category, deterministic=True)
    db.create_aggregate("median", 1, Median)
    dq = DQ()
    try:
        print("1/5 raw layer (CSV as delivered)")
        load_raw(db, dq)
        print("2/5 silver: cleaning the CSV history")
        db.executescript((HERE / "schema.sql").read_text(encoding="utf-8"))
        run_sql(db, "transform_csv.sql")
        csv_max = db.execute("SELECT MAX(season) FROM dim_season").fetchone()[0]
        if LIVE_DB.exists():
            print(f"3/5 silver: merging live seasons after {csv_max} from {LIVE_DB.name}")
            db.execute("ATTACH DATABASE ? AS live", (str(LIVE_DB),))
            run_sql(db, "transform_live.sql", {"csv_max": csv_max})
        else:
            print("3/5 skipped: no data/f1.db")
        print("4/5 silver: derived flags, lap pace, outliers")
        run_sql(db, "finalize.sql")
        print("5/5 gold: ML feature table")
        run_sql(db, "ml_features.sql")
        fk = quality_report(db, dq, csv_max)
        dq.save(db)
        db.commit()
        if LIVE_DB.exists():
            db.execute("DETACH DATABASE live")
        db.execute("VACUUM")
    except Exception:
        db.close()
        tmp.unlink(missing_ok=True)
        raise
    db.close()
    tmp.replace(WAREHOUSE)

    with sqlite3.connect(WAREHOUSE) as db:
        print("\nData-quality log:")
        for step, check, rows, note in db.execute("SELECT step, check_, rows, note FROM dq_log WHERE step <> 'raw'"):
            print(f"  [{step:<9}] {check:<62} {rows:>9,}  {note}")
        print("\nTables:")
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'raw_%' "
                                  "AND name <> 'dq_log' ORDER BY name"):
            print(f"  {name:<26} {db.execute(f'SELECT COUNT(*) FROM {name}').fetchone()[0]:>9,} rows")
    size = WAREHOUSE.stat().st_size / 1e6
    print(f"\nBuilt {WAREHOUSE.relative_to(HERE.parent)} ({size:.0f} MB) in {time.monotonic() - started:.0f}s"
          + ("" if not fk else "  -- WARNING: foreign-key violations, see dq_log"))
    return 1 if fk else 0


if __name__ == "__main__":
    sys.exit(main())
