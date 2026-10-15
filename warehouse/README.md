# F1 data warehouse

`data/warehouse.db` combines the historical dataset (`data/*.csv`, 1950–2024) with
the live seasons in `data/f1.db` (2026), cleaned and shaped for analysis and
machine learning. The website doesn't use it; it keeps running on `f1.db`.

```
python warehouse/build_warehouse.py     # full rebuild, ~10 s
```

Rebuild whenever the CSVs change or after `python ingest.py`. The source files
are the truth, so the warehouse is always regenerated from scratch.

## Layers

| Prefix | Layer | Contents |
|--------|-------|----------|
| `raw_` | bronze | Each CSV exactly as delivered, every column `TEXT`. For tracing a value back to its source. |
| `dim_` | silver | Cleaned, typed dimensions: `dim_season`, `dim_race`, `dim_circuit`, `dim_driver`, `dim_constructor`, `dim_status`. |
| `fct_` | silver | Cleaned facts: `fct_result`, `fct_sprint_result`, `fct_qualifying`, `fct_lap`, `fct_driver_race_pace`, `fct_pit_stop`, `fct_driver_standing`, `fct_constructor_standing`, `fct_constructor_result`. |
| `ml_`  | gold | `ml_driver_race`, one row per driver per race with leakage-safe features and targets. `ml_driver_race_modern` = 2014 onwards, starters only. |
| `dq_log` | | Every cleaning action and integrity check, with row counts. |

Dimensions use integer keys (`driver_key`, …); the `*_ref` columns (`max_verstappen`,
`red_bull`, `monaco`) are the natural keys shared with the live API, which is how
2026 rows join onto the same driver as his 2016 rows.

## Cleaning rules

| Problem in the source | Fix |
|---|---|
| `\N` and empty strings for missing values | Real `NULL` |
| Stray whitespace (`"Argentinian "`) | Trimmed |
| `grid = 0` means either a pit-lane start or not starting | `grid` is `NULL` when not on the grid; `is_pitlane_start`, `did_start` flags |
| Points systems differ by era (a win was 8, 9, 10, then 25) | `points_std` re-scores every result 25-18-15-12-10-8-6-4-2-1 |
| 139 free-text retirement reasons | `dim_status.category`: finished, lapped, mechanical, accident, driver, disqualified, did_not_qualify, did_not_start, retired_other |
| Same driver twice in one race (1950s shared cars) | Kept, flagged `is_shared_drive`, excluded from ML |
| Red-flag laps of up to two hours | `fct_lap.is_extreme_lap`; `is_green_lap` marks normal racing laps (within 107% of the driver's best, not lap 1) |
| "Pit stops" of 16 minutes (red-flag repairs) | `fct_pit_stop.is_long_stop` |
| Lap and qualifying times as text | Milliseconds (`*_ms`) |

## The ML table: `ml_driver_race`

**Leakage rule:** every feature uses only races *before* the one in that row
(all SQL windows end at `1 PRECEDING`). Columns are prefixed by when they're known:

| Prefix | Known | Examples |
|---|---|---|
| `pre_drv_*` | before the weekend | season average finish, last-5 form, last-3 race pace, DNF rate, record at this circuit, championship position |
| `pre_con_*` | before the weekend | the car: team's last-5 form, last-3 pace, mechanical DNF rate |
| `quali_*`, `grid` | after qualifying | qualifying position, gap to pole (%), grid slot |
| `target_*` | after the race, **labels only** | finishing order, position, points, win, podium, top 10, DNF |

Use `pre_*` features for season forecasts (qualifying isn't known yet) and add
`quali_*`/`grid` for race-day predictions.

Missing values are structural, not dirt: season features are empty at round 1,
circuit history on a first visit, `grid` for pit-lane starts.

Known gap: 2025 isn't in either source. Load it with `python ingest.py --season 2025`
and rebuild, so 2026's "last 5 races" features don't jump from 2024.

## Example queries

```sql
-- training set for a race-day model, hybrid era
SELECT * FROM ml_driver_race_modern WHERE season < 2026;

-- most dominant cars by average standardised points per entry
SELECT x.season, k.name, ROUND(AVG(r.points_std), 1) AS pts_per_entry
FROM fct_result r JOIN dim_race x USING (race_key) JOIN dim_constructor k USING (constructor_key)
GROUP BY x.season, k.constructor_key HAVING COUNT(*) >= 20 ORDER BY pts_per_entry DESC LIMIT 10;

-- what the cleaning changed
SELECT * FROM dq_log;
```
