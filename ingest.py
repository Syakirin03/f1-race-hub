#!/usr/bin/env python3
"""
F1 Race Hub - ingestion job (ETL): Jolpica F1 API -> SQLite (data/f1.db).

    python ingest.py                 # incremental sync of the current season
    python ingest.py --season 2025   # sync another season
    python ingest.py --full          # re-download every round of the season

Each write is an upsert inside a transaction and per-round progress is
recorded in sync_log, so re-running is safe and an interrupted run
resumes where it stopped. The latest completed round is always
re-fetched, to pick up post-race corrections such as penalties.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "f1.db"
SCHEMA_PATH = ROOT / "db" / "schema.sql"

API = "https://api.jolpi.ca/ergast/f1"
PAGE = 100            # the API's maximum page size
MIN_INTERVAL = 1.0    # seconds between requests: the API throttles sustained traffic faster than ~1/s (and caps 500/h)
USER_AGENT = "F1RaceHub-ingest/1.0"

TABLES = ("circuits", "drivers", "constructors", "races", "results",
          "qualifying", "laps", "pit_stops", "driver_standings")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Api:
    def __init__(self) -> None:
        self.calls = 0
        self._last = 0.0

    def get(self, path: str, **params) -> dict:
        query = urllib.parse.urlencode(params)
        url = f"{API}/{path}" + (f"?{query}" if query else "")
        for attempt in range(7):
            gap = MIN_INTERVAL - (time.monotonic() - self._last)
            if gap > 0:
                time.sleep(gap)
            self._last = time.monotonic()
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    self.calls += 1
                    return json.load(resp)
            except urllib.error.HTTPError as err:
                if err.code not in (429, 500, 502, 503, 504):
                    raise
                pause = _retry_after(err, attempt)
                print(f"    HTTP {err.code} from the API - waiting {pause:.0f}s, then retrying")
                time.sleep(pause)
            except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as err:
                pause = min(60, 3 * 2 ** attempt)
                print(f"    network error ({getattr(err, 'reason', err)}) - retrying in {pause}s")
                time.sleep(pause)
        raise RuntimeError(f"gave up after repeated failures: {url}")

    def pages(self, path: str):
        """Yield every page of a paginated endpoint."""
        offset = 0
        while True:
            page = self.get(path, limit=PAGE, offset=offset)
            yield page
            offset += PAGE
            if offset >= int(page["MRData"]["total"]):
                return


def _retry_after(err: urllib.error.HTTPError, attempt: int) -> float:
    header = err.headers.get("Retry-After") if err.headers else None
    try:
        return max(1.0, min(120.0, float(header)))
    except (TypeError, ValueError):
        return min(120.0, 5.0 * 2 ** attempt)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------
def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_ms(text):
    """'1:42.290' -> 102290, '24.048' -> 24048, '1:02:03.5' -> 3723500."""
    if not text:
        return None
    try:
        secs = 0.0
        for part in str(text).split(":"):
            secs = secs * 60 + float(part)
        return round(secs * 1000)
    except ValueError:
        return None


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def circuit_row(c: dict) -> dict:
    loc = c.get("Location") or {}
    return {"circuit_id": c["circuitId"], "name": c["circuitName"], "locality": loc.get("locality"),
            "country": loc.get("country"), "lat": to_float(loc.get("lat")), "lng": to_float(loc.get("long")),
            "url": c.get("url")}


def race_row(season: int, r: dict) -> dict:
    return {"season": season, "round": int(r["round"]), "race_name": r["raceName"],
            "circuit_id": r["Circuit"]["circuitId"], "date": r["date"], "time": r.get("time"),
            "url": r.get("url")}


def driver_row(d: dict) -> dict:
    return {"driver_id": d["driverId"], "code": d.get("code"), "permanent_number": d.get("permanentNumber"),
            "given_name": d.get("givenName", ""), "family_name": d.get("familyName", ""),
            "date_of_birth": d.get("dateOfBirth"), "nationality": d.get("nationality"), "url": d.get("url")}


def constructor_row(c: dict) -> dict:
    return {"constructor_id": c["constructorId"], "name": c["name"],
            "nationality": c.get("nationality"), "url": c.get("url")}


def result_row(season: int, rnd: int, x: dict) -> dict:
    t = x.get("Time") or {}
    fl = x.get("FastestLap") or {}
    speed = fl.get("AverageSpeed") or {}
    return {"season": season, "round": rnd, "driver_id": x["Driver"]["driverId"],
            "constructor_id": x["Constructor"]["constructorId"], "number": x.get("number"),
            "position": to_int(x.get("position")), "position_text": x.get("positionText"),
            "points": to_float(x.get("points")) or 0.0, "grid": to_int(x.get("grid")),
            "laps": to_int(x.get("laps")), "status": x.get("status"),
            "time_millis": to_int(t.get("millis")), "time_text": t.get("time"),
            "fl_rank": to_int(fl.get("rank")), "fl_lap": to_int(fl.get("lap")),
            "fl_time": (fl.get("Time") or {}).get("time"),
            "fl_speed": speed.get("speed"), "fl_speed_units": speed.get("units")}


def quali_row(season: int, rnd: int, q: dict) -> dict:
    return {"season": season, "round": rnd, "driver_id": q["Driver"]["driverId"],
            "constructor_id": q["Constructor"]["constructorId"], "number": q.get("number"),
            "position": to_int(q.get("position")), "q1": q.get("Q1"), "q2": q.get("Q2"), "q3": q.get("Q3")}


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.execute("PRAGMA journal_mode = WAL")   # the server can keep reading while we write
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    return db


def upsert(db: sqlite3.Connection, table: str, rows: list[dict], keys: list[str]) -> int:
    if not rows:
        return 0
    cols = list(rows[0])
    sets = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in keys)
    sql = (f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))}) "
           f"ON CONFLICT ({', '.join(keys)}) DO " + (f"UPDATE SET {sets}" if sets else "NOTHING"))
    db.executemany(sql, [tuple(r[c] for c in cols) for r in rows])
    return len(rows)


def replace_round(db, table, season, rnd, rows, keys) -> None:
    """Swap one round's partition of a fact table for fresh rows."""
    db.execute(f"DELETE FROM {table} WHERE season = ? AND round = ?", (season, rnd))
    upsert(db, table, rows, keys)


def mark(db, season, rnd, dataset, rows) -> None:
    db.execute("INSERT INTO sync_log (season, round, dataset, rows, synced_at) VALUES (?, ?, ?, ?, ?) "
               "ON CONFLICT (season, round, dataset) DO UPDATE SET rows = excluded.rows, synced_at = excluded.synced_at",
               (season, rnd, dataset, rows, now_iso()))


def synced_rounds(db, season, dataset) -> set[int]:
    return {r for (r,) in db.execute("SELECT round FROM sync_log WHERE season = ? AND dataset = ?", (season, dataset))}


def set_meta(db, key, value) -> None:
    db.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
               (key, value))


# ---------------------------------------------------------------------------
# Datasets
# ---------------------------------------------------------------------------
def sync_schedule(db, api, season: str) -> tuple[int, int]:
    table = api.get(f"{season}.json", limit=PAGE)["MRData"]["RaceTable"]
    year = int(table["season"])
    races = table["Races"]
    rounds = [int(r["round"]) for r in races]
    with db:
        upsert(db, "circuits", [circuit_row(r["Circuit"]) for r in races], ["circuit_id"])
        upsert(db, "races", [race_row(year, r) for r in races], ["season", "round"])
        # drop rounds that vanished from the calendar (cancelled), unless they already hold data
        if rounds:
            db.execute(
                f"DELETE FROM races WHERE season = ? AND round NOT IN ({', '.join('?' * len(rounds))}) "
                "AND NOT EXISTS (SELECT 1 FROM results x WHERE x.season = races.season AND x.round = races.round) "
                "AND NOT EXISTS (SELECT 1 FROM qualifying q WHERE q.season = races.season AND q.round = races.round)",
                (year, *rounds))
        mark(db, year, 0, "schedule", len(races))
    return year, len(races)


def sync_results(db, api, season: int) -> list[int]:
    by_round, drivers, teams = {}, {}, {}
    for page in api.pages(f"{season}/results.json"):
        for race in page["MRData"]["RaceTable"]["Races"]:
            rnd = int(race["round"])
            for x in race.get("Results", []):
                drivers[x["Driver"]["driverId"]] = driver_row(x["Driver"])
                teams[x["Constructor"]["constructorId"]] = constructor_row(x["Constructor"])
                by_round.setdefault(rnd, []).append(result_row(season, rnd, x))
    with db:
        upsert(db, "drivers", list(drivers.values()), ["driver_id"])
        upsert(db, "constructors", list(teams.values()), ["constructor_id"])
        for rnd, rows in by_round.items():
            replace_round(db, "results", season, rnd, rows, ["season", "round", "driver_id"])
        mark(db, season, 0, "results", sum(len(v) for v in by_round.values()))
    return sorted(by_round)


def sync_qualifying(db, api, season: int) -> int:
    by_round, drivers, teams = {}, {}, {}
    for page in api.pages(f"{season}/qualifying.json"):
        for race in page["MRData"]["RaceTable"]["Races"]:
            rnd = int(race["round"])
            for q in race.get("QualifyingResults", []):
                drivers[q["Driver"]["driverId"]] = driver_row(q["Driver"])
                teams[q["Constructor"]["constructorId"]] = constructor_row(q["Constructor"])
                by_round.setdefault(rnd, []).append(quali_row(season, rnd, q))
    total = sum(len(v) for v in by_round.values())
    with db:
        upsert(db, "drivers", list(drivers.values()), ["driver_id"])
        upsert(db, "constructors", list(teams.values()), ["constructor_id"])
        for rnd, rows in by_round.items():
            replace_round(db, "qualifying", season, rnd, rows, ["season", "round", "driver_id"])
        mark(db, season, 0, "qualifying", total)
    return total


def sync_standings(db, api, season: int, rnd: int) -> int:
    lists = api.get(f"{season}/{rnd}/driverstandings.json", limit=PAGE)["MRData"]["StandingsTable"]["StandingsLists"]
    entries = lists[0]["DriverStandings"] if lists else []
    if not entries:
        return 0
    drivers, teams, rows, links = {}, {}, [], []
    for e in entries:
        did = e["Driver"]["driverId"]
        drivers[did] = driver_row(e["Driver"])
        rows.append({"season": season, "round": rnd, "driver_id": did,
                     "position": to_int(e.get("position")), "position_text": e.get("positionText"),
                     "points": to_float(e.get("points")) or 0.0, "wins": to_int(e.get("wins")) or 0})
        for seq, c in enumerate(e.get("Constructors", [])):
            teams[c["constructorId"]] = constructor_row(c)
            links.append({"season": season, "round": rnd, "driver_id": did, "seq": seq,
                          "constructor_id": c["constructorId"]})
    with db:
        upsert(db, "drivers", list(drivers.values()), ["driver_id"])
        upsert(db, "constructors", list(teams.values()), ["constructor_id"])
        replace_round(db, "driver_standings", season, rnd, rows, ["season", "round", "driver_id"])
        replace_round(db, "driver_standing_teams", season, rnd, links, ["season", "round", "driver_id", "seq"])
        mark(db, season, rnd, "standings", len(rows))
    return len(rows)


def sync_pitstops(db, api, season: int, rnd: int) -> int:
    rows = []
    for page in api.pages(f"{season}/{rnd}/pitstops.json"):
        for race in page["MRData"]["RaceTable"]["Races"]:
            for p in race.get("PitStops", []):
                rows.append({"season": season, "round": rnd, "driver_id": p["driverId"],
                             "stop": to_int(p.get("stop")), "lap": to_int(p.get("lap")),
                             "time_of_day": p.get("time"), "duration_text": p.get("duration"),
                             "duration_ms": to_ms(p.get("duration"))})
    if not rows:            # not published yet: leave it unmarked so the next run retries
        return 0
    with db:
        replace_round(db, "pit_stops", season, rnd, rows, ["season", "round", "driver_id", "stop"])
        mark(db, season, rnd, "pitstops", len(rows))
    return len(rows)


def sync_laps(db, api, season: int, rnd: int) -> int:
    rows = []
    for page in api.pages(f"{season}/{rnd}/laps.json"):
        for race in page["MRData"]["RaceTable"]["Races"]:
            for lap in race.get("Laps", []):
                n = int(lap["number"])
                for t in lap.get("Timings", []):
                    rows.append({"season": season, "round": rnd, "lap": n, "driver_id": t["driverId"],
                                 "position": to_int(t.get("position")), "time_text": t.get("time"),
                                 "time_ms": to_ms(t.get("time"))})
    if not rows:
        return 0
    with db:
        replace_round(db, "laps", season, rnd, rows, ["season", "round", "lap", "driver_id"])
        mark(db, season, rnd, "laps", len(rows))
    return len(rows)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def run(season: str = "current", full: bool = False) -> None:
    started = time.monotonic()
    api = Api()
    db = connect()
    try:
        print(f"Syncing season '{season}' from {API} into {DB_PATH.relative_to(ROOT)}")
        year, n_races = sync_schedule(db, api, season)
        print(f"  schedule    {n_races} races in {year}")
        done = sync_results(db, api, year)
        print(f"  results     {len(done)} completed rounds")
        print(f"  qualifying  {sync_qualifying(db, api, year)} rows")

        latest = max(done) if done else None
        # cheap per-round datasets first, then the heavy lap telemetry
        for dataset, fn in (("standings", sync_standings), ("pitstops", sync_pitstops), ("laps", sync_laps)):
            have = set() if full else synced_rounds(db, year, dataset)
            todo = [r for r in done if r not in have or r == latest]
            for rnd in todo:
                n = fn(db, api, year, rnd)
                print(f"  {dataset:<10}  R{rnd:<2}  {n:>5} rows" + ("" if n else "  (not published yet)"))
            if not todo:
                print(f"  {dataset:<10}  up to date")

        with db:
            set_meta(db, "last_sync", now_iso())
            set_meta(db, "season", str(year))
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")   # fold the WAL back into the .db file
        db.execute("PRAGMA optimize")
        summary(db, api, started)
    finally:
        db.close()


def summary(db, api, started) -> None:
    print("\nDatabase contents:")
    for t in TABLES:
        n = db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"  {t:<18} {n:>8,} rows")
    size = DB_PATH.stat().st_size / 1_000_000
    print(f"\n{api.calls} API requests in {time.monotonic() - started:.0f}s; {DB_PATH.name} is {size:.1f} MB")


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Sync F1 data from the Jolpica API into the local SQLite database.")
    ap.add_argument("--season", default="current", help="a season year such as 2025, or 'current' (default)")
    ap.add_argument("--full", action="store_true", help="re-download every round instead of only new ones")
    args = ap.parse_args(argv)
    if args.season != "current" and not re.fullmatch(r"\d{4}", args.season):
        ap.error("--season must be a year such as 2025, or 'current'")
    try:
        run(args.season, args.full)
    except KeyboardInterrupt:
        print("\nInterrupted. Completed rounds are saved; run again to resume.")
        return 130
    except Exception as err:   # report cleanly; completed rounds stay committed
        print(f"\nSync failed: {err}\nCompleted rounds are saved; run again to resume.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
