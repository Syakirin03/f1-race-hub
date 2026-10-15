#!/usr/bin/env python3
"""
F1 Race Hub - static export for production.

Renders the website plus every data file it requests from data/f1.db into
dist/, ready for any static host or CDN (GitHub Pages, Cloudflare Pages,
Netlify, S3, ...). Production then needs no server and no database.

    python export.py                    # writes dist/
    python -m http.server -d dist 8080  # preview the production build

The JSON comes from the same code as server.py, so the published files are
identical to what the local server returns. Each endpoint is one file
holding every row (static hosts ignore ?limit= and ?offset=).
"""
from __future__ import annotations

import json
import shutil
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import server

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
SITE_FILES = ("index.html", "styles.css", "app.js")
EVERY_ROW = {"limit": [str(server.MAX_LIMIT)]}
ROUND_FILES = ("results", "qualifying", "laps", "pitstops", "driverstandings")


def write_json(rel: str, obj) -> int:
    path = DIST / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    path.write_bytes(data)
    return len(data)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    health = server.health()
    if not health.get("ok"):
        print(f"Nothing to export: {health.get('reason')}")
        return 1
    season = health["season"]
    with closing(server.open_db()) as db:
        rounds = [r for (r,) in db.execute("SELECT round FROM races WHERE season = ? ORDER BY round", (season,))]
        drivers = [d for (d,) in db.execute(
            "SELECT DISTINCT driver_id FROM results WHERE season = ? ORDER BY driver_id", (season,))]

    # every path app.js requests, for every round (empty files for rounds still to run)
    paths = ["current.json", "current/results.json", "current/driverstandings.json", "current/last/results.json"]
    paths += [f"current/{r}/{name}.json" for r in rounds for name in ROUND_FILES]
    paths += [f"current/drivers/{d}/results.json" for d in drivers]

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    for name in SITE_FILES:
        shutil.copy2(ROOT / name, DIST / name)
    # the next-season prediction is computed offline (ml/predict_next_season.py) and committed
    prediction = server.PREDICTIONS / "next-season.json"
    if prediction.exists():
        (DIST / "predictions").mkdir()
        shutil.copy2(prediction, DIST / "predictions" / prediction.name)
    else:
        print("note: predictions/next-season.json not found, so the prediction page will say it's unavailable")

    total = 0
    for p in paths:
        status, body = server.dispatch(p, EVERY_ROW)
        if status != 200:
            raise RuntimeError(f"{p}: HTTP {status} {body}")
        total += write_json(f"api/f1/{p}", body)
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    write_json("api/health.json", {**health, "source": "static", "generatedAt": generated})

    print(f"Exported season {season} (through round {health['lastRound']}): "
          f"{len(paths)} data files ({total / 1e6:.1f} MB) + {len(SITE_FILES)} site files -> {DIST.name}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
