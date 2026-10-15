#!/usr/bin/env python3
"""
F1 Race Hub - local server.

Serves the website plus an Ergast-compatible JSON API backed by the SQLite
database (data/f1.db), so the site reads your own copy of the data instead
of the live API.

    python server.py              # http://localhost:8000
    python server.py --port 9000
    python server.py --sync       # pull the latest results first, then serve

API: /api/health.json and /api/f1/<path>, where <path> mirrors the Jolpica
API, e.g. /api/f1/current/last/results.json or /api/f1/2026/17/laps.json.
export.py renders these same responses to static files for production.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import groupby
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "f1.db"
PREDICTIONS = ROOT / "predictions"   # written by ml/predict_next_season.py

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
DEFAULT_LIMIT = 1000   # the live API defaults to 30; locally there's no reason to truncate
MAX_LIMIT = 10000
TABLES = ("races", "results", "qualifying", "laps", "pit_stops", "driver_standings")


class NoData(Exception):
    """The database is missing or empty."""


def open_db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise NoData("No database yet - run: python ingest.py")
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only = ON")
    return db


# ---------------------------------------------------------------------------
# Serialisers: rows -> the API's JSON shapes (every scalar is a string)
# ---------------------------------------------------------------------------
def s(v):
    return None if v is None else str(v)


def num(v):
    if v is None:
        return None
    f = float(v)
    return str(int(f)) if f.is_integer() else str(f)


def clean(d: dict) -> dict:
    """Drop absent fields, as the API omits them (empty strings are kept)."""
    return {k: v for k, v in d.items() if v is not None}


RACE_SQL = """
SELECT r.season, r.round, r.race_name, r.date, r.time, r.url AS race_url,
       c.circuit_id, c.name AS circuit_name, c.locality, c.country, c.lat, c.lng, c.url AS circuit_url
FROM races r JOIN circuits c ON c.circuit_id = r.circuit_id
"""
DRIVER_COLS = """d.driver_id, d.code, d.permanent_number, d.given_name, d.family_name,
       d.date_of_birth, d.nationality AS driver_nat, d.url AS driver_url"""
TEAM_COLS = "k.constructor_id, k.name AS team_name, k.nationality AS team_nat, k.url AS team_url"
RESULT_SQL = f"""
SELECT x.season, x.round, x.number, x.position, x.position_text, x.points, x.grid, x.laps, x.status,
       x.time_millis, x.time_text, x.fl_rank, x.fl_lap, x.fl_time, x.fl_speed, x.fl_speed_units,
       {DRIVER_COLS}, {TEAM_COLS}
FROM results x
JOIN drivers d      ON d.driver_id = x.driver_id
JOIN constructors k ON k.constructor_id = x.constructor_id
"""
QUALI_SQL = f"""
SELECT q.number, q.position, q.q1, q.q2, q.q3, {DRIVER_COLS}, {TEAM_COLS}
FROM qualifying q
JOIN drivers d      ON d.driver_id = q.driver_id
JOIN constructors k ON k.constructor_id = q.constructor_id
"""


def race_obj(r) -> dict:
    return clean({
        "season": s(r["season"]), "round": s(r["round"]), "url": r["race_url"], "raceName": r["race_name"],
        "Circuit": clean({
            "circuitId": r["circuit_id"], "url": r["circuit_url"], "circuitName": r["circuit_name"],
            "Location": clean({"lat": s(r["lat"]), "long": s(r["lng"]),
                               "locality": r["locality"], "country": r["country"]}),
        }),
        "date": r["date"], "time": r["time"],
    })


def driver_obj(r) -> dict:
    return clean({"driverId": r["driver_id"], "permanentNumber": r["permanent_number"], "code": r["code"],
                  "url": r["driver_url"], "givenName": r["given_name"], "familyName": r["family_name"],
                  "dateOfBirth": r["date_of_birth"], "nationality": r["driver_nat"]})


def team_obj(r) -> dict:
    return clean({"constructorId": r["constructor_id"], "url": r["team_url"],
                  "name": r["team_name"], "nationality": r["team_nat"]})


def result_obj(r) -> dict:
    o = {"number": r["number"], "position": s(r["position"]), "positionText": r["position_text"],
         "points": num(r["points"]), "Driver": driver_obj(r), "Constructor": team_obj(r),
         "grid": s(r["grid"]), "laps": s(r["laps"]), "status": r["status"]}
    if r["time_text"] is not None:
        o["Time"] = clean({"millis": s(r["time_millis"]), "time": r["time_text"]})
    if r["fl_time"] is not None or r["fl_rank"] is not None:
        fl = {"rank": s(r["fl_rank"]), "lap": s(r["fl_lap"]),
              "Time": {"time": r["fl_time"]} if r["fl_time"] is not None else None}
        if r["fl_speed"] is not None:
            fl["AverageSpeed"] = clean({"units": r["fl_speed_units"], "speed": r["fl_speed"]})
        o["FastestLap"] = clean(fl)
    return clean(o)


def envelope(path, page, total, key, table) -> dict:
    limit, offset = page
    return {"MRData": {"xmlns": "", "series": "f1", "url": f"/api/f1/{path}", "limit": str(limit),
                       "offset": str(offset), "total": str(total), key: table}}


def count(db, sql, args) -> int:
    return db.execute(sql, args).fetchone()[0]


def get_race(db, season, rnd):
    row = db.execute(RACE_SQL + " WHERE r.season = ? AND r.round = ?", (season, rnd)).fetchone()
    return race_obj(row) if row else None


def races_by_round(db, season) -> dict:
    return {row["round"]: race_obj(row) for row in db.execute(RACE_SQL + " WHERE r.season = ?", (season,))}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
def api_schedule(db, path, season, rnd, page, driver=None):
    total = count(db, "SELECT COUNT(*) FROM races WHERE season = ?", (season,))
    rows = db.execute(RACE_SQL + " WHERE r.season = ? ORDER BY r.round LIMIT ? OFFSET ?", (season, *page)).fetchall()
    return envelope(path, page, total, "RaceTable", {"season": s(season), "Races": [race_obj(r) for r in rows]})


def api_race_results(db, path, season, rnd, page, driver=None):
    table = {"season": s(season), "round": s(rnd), "Races": []}
    total = 0
    if rnd is not None:
        total = count(db, "SELECT COUNT(*) FROM results WHERE season = ? AND round = ?", (season, rnd))
        rows = db.execute(RESULT_SQL + " WHERE x.season = ? AND x.round = ? ORDER BY x.position LIMIT ? OFFSET ?",
                          (season, rnd, *page)).fetchall()
        race = get_race(db, season, rnd)
        if rows and race:
            race["Results"] = [result_obj(r) for r in rows]
            table["Races"].append(race)
    return envelope(path, page, total, "RaceTable", clean(table))


def _grouped_results(db, season, rows):
    races = races_by_round(db, season)
    out = []
    for rnd, grp in groupby(rows, key=lambda r: r["round"]):
        race = races.get(rnd)
        if race:
            race["Results"] = [result_obj(r) for r in grp]
            out.append(race)
    return out


def api_season_results(db, path, season, rnd, page, driver=None):
    total = count(db, "SELECT COUNT(*) FROM results WHERE season = ?", (season,))
    rows = db.execute(RESULT_SQL + " WHERE x.season = ? ORDER BY x.round, x.position LIMIT ? OFFSET ?",
                      (season, *page)).fetchall()
    return envelope(path, page, total, "RaceTable", {"season": s(season), "Races": _grouped_results(db, season, rows)})


def api_driver_results(db, path, season, rnd, page, driver=None):
    total = count(db, "SELECT COUNT(*) FROM results WHERE season = ? AND driver_id = ?", (season, driver))
    rows = db.execute(RESULT_SQL + " WHERE x.season = ? AND x.driver_id = ? ORDER BY x.round LIMIT ? OFFSET ?",
                      (season, driver, *page)).fetchall()
    return envelope(path, page, total, "RaceTable",
                    {"season": s(season), "driverId": driver, "Races": _grouped_results(db, season, rows)})


def api_laps(db, path, season, rnd, page, driver=None):
    table = {"season": s(season), "round": s(rnd), "Races": []}
    total = count(db, "SELECT COUNT(*) FROM laps WHERE season = ? AND round = ?", (season, rnd))
    rows = db.execute("SELECT lap, driver_id, position, time_text FROM laps WHERE season = ? AND round = ? "
                      "ORDER BY lap, position LIMIT ? OFFSET ?", (season, rnd, *page)).fetchall()
    race = get_race(db, season, rnd) if rows else None
    if race:
        race["Laps"] = [{"number": s(lap), "Timings": [
            clean({"driverId": t["driver_id"], "position": s(t["position"]), "time": t["time_text"]}) for t in grp
        ]} for lap, grp in groupby(rows, key=lambda r: r["lap"])]
        table["Races"].append(race)
    return envelope(path, page, total, "RaceTable", clean(table))


def api_pitstops(db, path, season, rnd, page, driver=None):
    table = {"season": s(season), "round": s(rnd), "Races": []}
    total = count(db, "SELECT COUNT(*) FROM pit_stops WHERE season = ? AND round = ?", (season, rnd))
    rows = db.execute("SELECT driver_id, lap, stop, time_of_day, duration_text FROM pit_stops "
                      "WHERE season = ? AND round = ? ORDER BY time_of_day, lap, driver_id LIMIT ? OFFSET ?",
                      (season, rnd, *page)).fetchall()
    race = get_race(db, season, rnd) if rows else None
    if race:
        race["PitStops"] = [clean({"driverId": p["driver_id"], "lap": s(p["lap"]), "stop": s(p["stop"]),
                                   "time": p["time_of_day"], "duration": p["duration_text"]}) for p in rows]
        table["Races"].append(race)
    return envelope(path, page, total, "RaceTable", clean(table))


def api_qualifying(db, path, season, rnd, page, driver=None):
    table = {"season": s(season), "round": s(rnd), "Races": []}
    total = count(db, "SELECT COUNT(*) FROM qualifying WHERE season = ? AND round = ?", (season, rnd))
    rows = db.execute(QUALI_SQL + " WHERE q.season = ? AND q.round = ? ORDER BY q.position LIMIT ? OFFSET ?",
                      (season, rnd, *page)).fetchall()
    race = get_race(db, season, rnd) if rows else None
    if race:
        race["QualifyingResults"] = [clean({
            "number": q["number"], "position": s(q["position"]), "Driver": driver_obj(q), "Constructor": team_obj(q),
            "Q1": q["q1"], "Q2": q["q2"], "Q3": q["q3"],
        }) for q in rows]
        table["Races"].append(race)
    return envelope(path, page, total, "RaceTable", clean(table))


def api_standings(db, path, season, rnd, page, driver=None):
    if rnd is None:   # no round in the path: the latest standings
        rnd = db.execute("SELECT MAX(round) FROM driver_standings WHERE season = ?", (season,)).fetchone()[0]
    table = {"season": s(season), "round": s(rnd), "StandingsLists": []}
    total = 0
    if rnd is not None:
        total = count(db, "SELECT COUNT(*) FROM driver_standings WHERE season = ? AND round = ?", (season, rnd))
        rows = db.execute(f"SELECT st.position, st.position_text, st.points, st.wins, {DRIVER_COLS} "
                          "FROM driver_standings st JOIN drivers d ON d.driver_id = st.driver_id "
                          "WHERE st.season = ? AND st.round = ? "
                          "ORDER BY st.position IS NULL, st.position LIMIT ? OFFSET ?", (season, rnd, *page)).fetchall()
        teams = defaultdict(list)
        for t in db.execute(f"SELECT t.driver_id, {TEAM_COLS} FROM driver_standing_teams t "
                            "JOIN constructors k ON k.constructor_id = t.constructor_id "
                            "WHERE t.season = ? AND t.round = ? ORDER BY t.driver_id, t.seq", (season, rnd)):
            teams[t["driver_id"]].append(team_obj(t))
        if rows:
            table["StandingsLists"].append({"season": s(season), "round": s(rnd), "DriverStandings": [clean({
                "position": s(r["position"]), "positionText": r["position_text"], "points": num(r["points"]),
                "wins": s(r["wins"]), "Driver": driver_obj(r), "Constructors": teams.get(r["driver_id"], []),
            }) for r in rows]})
    return envelope(path, page, total, "StandingsTable", clean(table))


SEASON = r"(?P<season>current|\d{4})"
ROUND = r"(?P<round>last|\d{1,2})"
ROUTES = [(re.compile(p, re.IGNORECASE), fn) for p, fn in (
    (rf"^{SEASON}\.json$", api_schedule),
    (rf"^{SEASON}/results\.json$", api_season_results),
    (rf"^{SEASON}/driverstandings\.json$", api_standings),
    (rf"^{SEASON}/{ROUND}/driverstandings\.json$", api_standings),
    (rf"^{SEASON}/{ROUND}/results\.json$", api_race_results),
    (rf"^{SEASON}/{ROUND}/laps\.json$", api_laps),
    (rf"^{SEASON}/{ROUND}/pitstops\.json$", api_pitstops),
    (rf"^{SEASON}/{ROUND}/qualifying\.json$", api_qualifying),
    (rf"^{SEASON}/drivers/(?P<driver>[A-Za-z0-9_-]+)/results\.json$", api_driver_results),
)]


def page_args(query) -> tuple[int, int]:
    def pick(name, default, lo, hi):
        try:
            v = int(query.get(name, [default])[0])
        except (TypeError, ValueError):
            v = default
        return max(lo, min(hi, v))
    return pick("limit", DEFAULT_LIMIT, 1, MAX_LIMIT), pick("offset", 0, 0, 10 ** 9)


def dispatch(path: str, query) -> tuple[int, dict]:
    for pattern, handler in ROUTES:
        m = pattern.match(path)
        if not m:
            continue
        g = m.groupdict()
        with closing(open_db()) as db:
            token = g["season"].lower()
            season = (db.execute("SELECT MAX(season) FROM races").fetchone()[0]
                      if token == "current" else int(token))
            if season is None:
                raise NoData("The database is empty - run: python ingest.py")
            rnd = g.get("round")
            if rnd is not None:
                rnd = (db.execute("SELECT MAX(round) FROM results WHERE season = ?", (season,)).fetchone()[0]
                       if rnd.lower() == "last" else int(rnd))
            return 200, handler(db, path, season, rnd, page_args(query), driver=g.get("driver"))
    return 404, {"error": f"unknown endpoint: {path}"}


def health() -> dict:
    try:
        with closing(open_db()) as db:
            season = db.execute("SELECT MAX(season) FROM races").fetchone()[0]
            if season is None:
                return {"ok": False, "reason": "The local database is empty - run: python ingest.py"}
            last = db.execute("SELECT MAX(round) FROM results WHERE season = ?", (season,)).fetchone()[0]
            meta = {r[0]: r[1] for r in db.execute("SELECT key, value FROM meta")}
            rows = {t: count(db, f"SELECT COUNT(*) FROM {t}", ()) for t in TABLES}
            return {"ok": True, "source": "sqlite", "database": "data/f1.db", "season": season,
                    "lastRound": last, "lastSync": meta.get("last_sync"), "rows": rows}
    except NoData as err:
        return {"ok": False, "reason": str(err)}
    except sqlite3.Error as err:
        return {"ok": False, "reason": f"database error: {err}"}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "F1RaceHub/1.0"

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path in ("/api/health", "/api/health.json"):
                return self.send_json(200, health())
            if url.path.startswith("/api/f1/"):
                return self.send_json(*dispatch(url.path[len("/api/f1/"):], parse_qs(url.query)))
            if url.path.startswith("/api/"):
                return self.send_json(404, {"error": "unknown endpoint"})
            return self.serve_static(url.path)
        except NoData as err:
            return self.send_json(503, {"error": str(err)})
        except Exception as err:   # keep the server up and say what went wrong
            self.log_error("error on %s: %r", self.path, err)
            return self.send_json(500, {"error": "internal error", "detail": str(err)})

    def send_json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, path: str) -> None:
        rel = "index.html" if path in ("", "/") else unquote(path).lstrip("/")
        target = (ROOT / rel).resolve()
        ctype = STATIC_TYPES.get(target.suffix.lower())
        if target.suffix.lower() == ".json" and target.parent == PREDICTIONS:
            ctype = "application/json; charset=utf-8"    # the published prediction, and no other JSON
        # only whitelisted file types inside the project folder (never the .db or .py files)
        if not ctype or not target.is_relative_to(ROOT) or not target.is_file():
            body = b"Not found"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind a port that is already
    # in use, which hides "port busy" errors, so only enable it elsewhere.
    allow_reuse_address = sys.platform != "win32"


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Serve F1 Race Hub with its local SQLite database.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--sync", action="store_true", help="run an incremental ingest before serving")
    args = ap.parse_args(argv)

    if args.sync:
        import ingest
        ingest.main([])

    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError as err:
        print(f"Can't listen on port {args.port} ({err}). Is another server running? Try --port 8001.")
        return 1
    h = health()
    status = (f"season {h['season']} through round {h['lastRound']}, synced {h['lastSync']}"
              if h.get("ok") else h.get("reason"))
    print(f"F1 Race Hub on http://localhost:{args.port}  (database: {status})")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
