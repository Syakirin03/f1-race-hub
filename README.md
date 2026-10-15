# F1 Race Hub

A live Formula 1 results website. The homepage shows the latest Grand Prix
result, you can browse every round of the current season, and a sidebar lets you
open any driver's season data (stats + charts).

## Features

- **Latest Race** (home) — podium + full classification for the most recent Grand Prix.
- **Season** — the full calendar; click any completed round to see its results.
- **Standings** — the current drivers' championship.
- **Race Analytics** — a dashboard (pick any completed round) with:
  - KPI tiles (winner, pole, fastest lap, biggest climber, lead changes, DNFs);
  - positions gained/lost and points-by-team bar charts;
  - a **race-progression** chart (track position on every lap, coloured by team);
  - a **lap-time pace** chart for the top 5, with a snapping crosshair;
  - a **pit-stop strategy** (stint) chart;
  - a driver-analysis table with best lap, median green-lap pace, consistency (σ),
    stops and points.
- **Title Forecast** — a championship projection by **Monte-Carlo simulation**
  (5,000 simulated seasons, resampling each driver's own per-race points over the
  remaining rounds): title probabilities, projected final points with a P10–P90
  range, and a mathematical "title clinched / still open" check.
- **2027 Prediction** — a machine-learning forecast of next season's championship:
  title chances, predicted points ranges and final-position probabilities, plus
  a plain-English explanation of the model, the calculation for every driver,
  its backtest on 2016–2024 and its limitations. See
  [Next-season prediction](#next-season-prediction).
- **Drivers** (sidebar dropdown) — pick a driver for their season stats, a
  grid-vs-finish chart, a points-progression chart (with a dashed season-end
  projection), and a race-by-race table.
- Dark / light theme toggle, responsive layout, F1 team colours and flags.

## The data pipeline (data-engineering layer)

The dashboard is a small in-browser pipeline. For a round it pulls the results,
**~1,200 individual lap-timing rows** (paged 100 at a time from the API), the pit
stops, and the qualifying times, then joins them by driver and derives everything
on the client: per-lap position matrix, lead changes, fastest lap, green-lap pace
(laps within 107% of a driver's best), lap-time consistency (standard deviation),
and pit stints. Lap datasets are cached per round so re-opening a race is instant.

## Running it

The site reads from a local **SQLite database** (`data/f1.db`). Everything uses
Python's standard library, so there's nothing to install.

```
cd "F1 Telemetry"
python ingest.py     # download the season into data/f1.db (first run: ~3-4 min)
python server.py     # serve the site + database on http://localhost:8000
```

After each race weekend, run `python ingest.py` again (or start the server with
`python server.py --sync`). It only downloads what's new, about 20 requests.

The sidebar footer shows where the data is coming from: **Local DB** (green) when
`server.py` is running with a populated database, or **Live API** (blue) as a
fallback, for example when the folder is served by another static server.

## The local database

`ingest.py` is an incremental ETL job: Jolpica API → normalised SQLite tables.
Writes are upserts inside transactions and progress is logged per round in
`sync_log`, so re-runs are safe and an interrupted sync resumes where it stopped.
The latest round is always re-fetched to pick up post-race penalties.

| Table | Grain |
|-------|-------|
| `circuits`, `drivers`, `constructors` | one row per entity |
| `races` | one row per round (the full calendar, including upcoming races) |
| `results` | one row per driver per race |
| `qualifying` | one row per driver per qualifying session (Q1–Q3 times) |
| `laps` | one row per driver per lap (position and lap time) |
| `pit_stops` | one row per pit stop |
| `driver_standings` | the championship table after every round |
| `driver_standing_teams` | the team(s) a driver drove for, per round |
| `sync_log`, `meta` | pipeline bookkeeping |

Views for analysis: `v_results`, `v_driver_season`, `v_race_pace`,
`v_pit_summary`, `v_championship`. Open the file in any SQLite tool (DB Browser
for SQLite, a VS Code SQLite extension, pandas) or query it directly:

```sql
-- championship lead after every round
SELECT round, race_name, driver, points FROM v_championship
WHERE season = 2026 AND position = 1 ORDER BY round;

-- fastest pit stop of each race
SELECT round, driver_id, MIN(duration_ms) / 1000.0 AS seconds
FROM pit_stops WHERE season = 2026 GROUP BY round ORDER BY round;
```

`server.py` exposes the database as an API with the same paths and JSON shape as
Jolpica (`/api/f1/current/last/results.json`, `/api/f1/2026/17/laps.json`, …),
plus `/api/health`. That's why the frontend can switch sources without any other
changes. Backfill another season with `python ingest.py --season 2025`.

## Going live (production)

Production is a **static site**: `export.py` renders every data file the site
requests from the database into `dist/`, and any static host serves it. There's
no server to run or patch, and HTTPS and a global CDN come free. A GitHub Actions
workflow (`.github/workflows/deploy.yml`) refreshes it every day at 06:17 UTC:
`ingest.py` → `export.py` → GitHub Pages.

One-time setup:

1. Create a **public** repository on GitHub, for example `f1-race-hub`. Free
   GitHub Pages needs a public repo; private repos need a paid plan.
2. Push this folder to it:
   ```
   git init -b main
   git add .
   git commit -m "F1 Race Hub"
   git remote add origin https://github.com/<your-username>/f1-race-hub.git
   git push -u origin main
   ```
3. In the repo, open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Open **Actions → Update data and deploy → Run workflow**. The first run
   downloads the whole season (about 5 minutes); later runs take under a minute.
5. The site is live at `https://<your-username>.github.io/f1-race-hub/`.

Optional custom domain: **Settings → Pages → Custom domain**, then add the DNS
record GitHub shows you (a `CNAME` pointing at `<your-username>.github.io`) and
tick **Enforce HTTPS**.

Preview the production build locally with
`python export.py` then `python -m http.server -d dist 8080`.

Good to know:
- If a run fails (for example the API is down), the previous version stays live
  and GitHub emails you. Re-run it from the Actions tab.
- GitHub pauses scheduled workflows after 60 days without repository activity,
  which can happen in the winter break. It emails you first; click
  **Enable workflow** on the Actions tab when the new season starts.
- Any static host works with `dist/`: Cloudflare Pages, Netlify, an S3 bucket.

## Next-season prediction

The **2027 Prediction** page reads one file, `predictions/next-season.json`. It's
computed **offline**, because it needs the historical results in the data
warehouse (`data/warehouse.db`, built from the CSV archive in `data/`, which
isn't committed). GitHub Actions can't rebuild it, so the file is committed and
published as it is.

To refresh it (for example after each remaining race, and once the season ends):

```
python ingest.py                          # latest results into data/f1.db
python warehouse/build_warehouse.py       # rebuild the warehouse
python ml/predict_next_season.py          # writes predictions/next-season.json
git add predictions/next-season.json && git commit -m "Update 2027 prediction" && git push
```

`ml/predict_next_season.py` needs numpy, pandas and scipy, and takes a few seconds.
Edit `N_RACES` or `LINEUP_CHANGES` at the top of it when the 2027 calendar or
driver moves are announced. The method is explained step by step in
`ml/02_season_2027.ipynb`.

## Data source

[Jolpica F1 API](https://github.com/jolpica/jolpica-f1), the community-maintained
successor to the Ergast API (`https://api.jolpi.ca/ergast/f1`). It's used by
`ingest.py` and as the browser's fallback when the local database isn't available.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell + sidebar |
| `styles.css` | Theme tokens and all styling |
| `app.js` | Data fetching, routing, views, and the SVG charts |
| `ingest.py` | ETL: Jolpica API → `data/f1.db` |
| `server.py` | Serves the site and the database API locally |
| `export.py` | Builds the static production site into `dist/` |
| `db/schema.sql` | Tables, indexes and analysis views |
| `.github/workflows/deploy.yml` | Daily sync, build and deploy to GitHub Pages |
| `data/f1.db` | The SQLite database (created by `ingest.py`, not committed) |
| `ml/predict_next_season.py` | Computes the next-season prediction from the warehouse |
| `predictions/next-season.json` | The published prediction (committed) |

No build step. The website itself has no third-party dependencies; only the
offline prediction script uses numpy, pandas and scipy.
