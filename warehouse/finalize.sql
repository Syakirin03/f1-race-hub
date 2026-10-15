-- ============================================================
-- Derived columns and flags, once both sources are loaded.
-- ============================================================

-- chronological order across all seasons, for "races before this one" windows
UPDATE dim_race SET race_seq = (
    SELECT rn FROM (SELECT race_key, ROW_NUMBER() OVER (ORDER BY race_date, round) AS rn FROM dim_race) t
    WHERE t.race_key = dim_race.race_key);
CREATE UNIQUE INDEX idx_race_seq ON dim_race (race_seq);

-- results: who started, how they finished
UPDATE fct_result SET
    is_classified = (position IS NOT NULL),
    did_start = CASE
        WHEN position_text IN ('F', 'W') THEN 0                     -- failed to qualify / withdrawn
        WHEN (SELECT category FROM dim_status s WHERE s.status_key = fct_result.status_key)
             IN ('did_not_qualify', 'did_not_start') THEN 0
        ELSE 1 END;

UPDATE fct_result SET
    grid             = CASE WHEN grid_raw > 0 THEN grid_raw END,
    is_pitlane_start = (grid_raw = 0 AND did_start = 1),
    is_finished      = (SELECT category FROM dim_status s WHERE s.status_key = fct_result.status_key)
                       IN ('finished', 'lapped'),
    -- one points scale for every era, so 1958 and 2024 results are comparable
    points_std = CASE position WHEN 1 THEN 25 WHEN 2 THEN 18 WHEN 3 THEN 15 WHEN 4 THEN 12 WHEN 5 THEN 10
                               WHEN 6 THEN 8 WHEN 7 THEN 6 WHEN 8 THEN 4 WHEN 9 THEN 2 WHEN 10 THEN 1 ELSE 0 END;

UPDATE fct_result SET
    is_dnf = (did_start = 1 AND is_finished = 0
              AND (SELECT category FROM dim_status s WHERE s.status_key = fct_result.status_key) <> 'disqualified');

UPDATE fct_result SET is_shared_drive = 1
WHERE (race_key, driver_key) IN (
    SELECT race_key, driver_key FROM fct_result GROUP BY race_key, driver_key HAVING COUNT(*) > 1);

-- qualifying: fastest of the three sessions
UPDATE fct_qualifying SET best_ms = NULLIF(MIN(COALESCE(q1_ms, 999999999), COALESCE(q2_ms, 999999999),
                                               COALESCE(q3_ms, 999999999)), 999999999);

-- laps: flag green-flag racing laps and extreme ones (red flags)
CREATE TEMP TABLE race_median AS
SELECT race_key, median(lap_ms) AS median_ms FROM lap_stage GROUP BY race_key;

INSERT INTO fct_lap (race_key, driver_key, lap, position, lap_ms, is_green_lap, is_extreme_lap)
SELECT l.race_key, l.driver_key, l.lap, l.position, l.lap_ms,
       (l.lap > 1 AND l.lap_ms <= 1.07 * MIN(l.lap_ms) OVER (PARTITION BY l.race_key, l.driver_key)),
       (l.lap_ms > 2 * m.median_ms)
FROM lap_stage l JOIN race_median m ON m.race_key = l.race_key;

-- pace per driver per race: median green lap, relative to the race's quickest
CREATE TEMP TABLE drv_pace AS
SELECT race_key, driver_key, COUNT(*) AS laps, SUM(is_green_lap) AS green_laps, MIN(lap_ms) AS best_lap_ms,
       median(CASE WHEN is_green_lap THEN lap_ms END) AS median_green_ms
FROM fct_lap GROUP BY race_key, driver_key;

INSERT INTO fct_driver_race_pace
SELECT race_key, driver_key, laps, green_laps, best_lap_ms, median_green_ms,
       CASE WHEN green_laps >= 5 THEN ROUND(100.0 * (median_green_ms /
            MIN(CASE WHEN green_laps >= 5 THEN median_green_ms END) OVER (PARTITION BY race_key) - 1), 3) END
FROM drv_pace;

-- pit stops: anything over 2 minutes is red-flag repair work, not a pit stop
UPDATE fct_pit_stop SET is_long_stop = (duration_ms > 120000);
