-- ============================================================
-- Gold layer: ml_driver_race, one row per driver per race.
--
-- LEAKAGE RULE: every feature is computed from races *before* this one.
-- All windows end at "1 PRECEDING", so the race being predicted is never
-- inside its own features. Columns are grouped by when they're known:
--   pre_*   known before qualifying (form, experience, standings)
--   quali_* / grid  known after qualifying, before the race
--   target_*        the outcome, for training only, never use as a feature
-- Shared drives (1950s) are excluded.
-- ============================================================

DROP TABLE IF EXISTS ml_driver_race;
CREATE TABLE ml_driver_race AS
WITH base AS (
    SELECT r.result_key, x.race_key, x.season, x.round, x.race_seq, x.race_date, x.circuit_key,
           r.driver_key, r.constructor_key, r.grid, r.is_pitlane_start, r.position, r.position_order,
           r.points_std, r.did_start, r.is_finished, r.is_dnf, s.category AS status_category,
           d.date_of_birth, p.pace_gap_pct
    FROM fct_result r
    JOIN dim_race x   ON x.race_key = r.race_key
    JOIN dim_status s ON s.status_key = r.status_key
    JOIN dim_driver d ON d.driver_key = r.driver_key
    LEFT JOIN fct_driver_race_pace p ON p.race_key = r.race_key AND p.driver_key = r.driver_key
    WHERE r.is_shared_drive = 0
),
drv AS (
    SELECT result_key,
        SUM(did_start)           OVER career  AS pre_drv_career_starts,
        COUNT(*)                 OVER season  AS pre_drv_season_races,
        AVG(position_order)      OVER season  AS pre_drv_season_avg_pos,
        SUM(points_std)          OVER season  AS pre_drv_season_pts_std,
        AVG(position_order)      OVER last5   AS pre_drv_last5_avg_pos,
        AVG(points_std)          OVER last5   AS pre_drv_last5_avg_pts,
        AVG(pace_gap_pct)        OVER last3   AS pre_drv_last3_pace_gap_pct,
        AVG(is_dnf)              OVER last10  AS pre_drv_last10_dnf_rate,
        COUNT(*)                 OVER circuit AS pre_drv_circuit_races,
        AVG(position_order)      OVER circuit AS pre_drv_circuit_avg_pos
    FROM base
    WINDOW career  AS (PARTITION BY driver_key ORDER BY race_seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
           season  AS (PARTITION BY driver_key, season ORDER BY race_seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
           last3   AS (PARTITION BY driver_key ORDER BY race_seq ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING),
           last5   AS (PARTITION BY driver_key ORDER BY race_seq ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING),
           last10  AS (PARTITION BY driver_key ORDER BY race_seq ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING),
           circuit AS (PARTITION BY driver_key, circuit_key ORDER BY race_seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
),
-- the car: both entries of a team per race, then form over earlier races
con_race AS (
    SELECT race_key, constructor_key, season, race_seq,
           AVG(position_order) AS avg_pos, AVG(points_std) AS avg_pts, AVG(pace_gap_pct) AS pace_gap_pct,
           SUM(is_dnf AND status_category = 'mechanical') AS mech_dnfs, COUNT(*) AS cars
    FROM base GROUP BY race_key, constructor_key
),
con AS (
    SELECT race_key, constructor_key,
        AVG(avg_pos)       OVER season AS pre_con_season_avg_pos,
        AVG(avg_pts)       OVER season AS pre_con_season_avg_pts,
        AVG(avg_pos)       OVER last5  AS pre_con_last5_avg_pos,
        AVG(avg_pts)       OVER last5  AS pre_con_last5_avg_pts,
        AVG(pace_gap_pct)  OVER last3  AS pre_con_last3_pace_gap_pct,
        1.0 * SUM(mech_dnfs) OVER last10 / NULLIF(SUM(cars) OVER last10, 0) AS pre_con_last10_mech_dnf_rate
    FROM con_race
    WINDOW season AS (PARTITION BY constructor_key, season ORDER BY race_seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
           last3  AS (PARTITION BY constructor_key ORDER BY race_seq ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING),
           last5  AS (PARTITION BY constructor_key ORDER BY race_seq ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING),
           last10 AS (PARTITION BY constructor_key ORDER BY race_seq ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)
),
prev AS (   -- the previous round of the same season, for "championship position before this race"
    SELECT race_key, LAG(race_key) OVER (PARTITION BY season ORDER BY round) AS prev_race_key FROM dim_race
),
quali AS (
    SELECT race_key, driver_key, position AS quali_position,
           ROUND(100.0 * (1.0 * best_ms / MIN(best_ms) OVER (PARTITION BY race_key) - 1), 3) AS quali_gap_pct
    FROM fct_qualifying
)
SELECT
    -- identifiers (not features)
    b.result_key, b.race_key, b.season, b.round, b.race_date,
    c.circuit_ref, d.driver_ref, k.constructor_ref,
    -- pre-qualifying features
    ROUND((julianday(b.race_date) - julianday(b.date_of_birth)) / 365.25, 2) AS pre_driver_age,
    drv.pre_drv_career_starts, drv.pre_drv_season_races,
    ROUND(drv.pre_drv_season_avg_pos, 3) AS pre_drv_season_avg_pos, drv.pre_drv_season_pts_std,
    ROUND(drv.pre_drv_last5_avg_pos, 3) AS pre_drv_last5_avg_pos,
    ROUND(drv.pre_drv_last5_avg_pts, 3) AS pre_drv_last5_avg_pts,
    ROUND(drv.pre_drv_last3_pace_gap_pct, 3) AS pre_drv_last3_pace_gap_pct,
    ROUND(drv.pre_drv_last10_dnf_rate, 3) AS pre_drv_last10_dnf_rate,
    drv.pre_drv_circuit_races, ROUND(drv.pre_drv_circuit_avg_pos, 3) AS pre_drv_circuit_avg_pos,
    ROUND(con.pre_con_season_avg_pos, 3) AS pre_con_season_avg_pos,
    ROUND(con.pre_con_season_avg_pts, 3) AS pre_con_season_avg_pts,
    ROUND(con.pre_con_last5_avg_pos, 3) AS pre_con_last5_avg_pos,
    ROUND(con.pre_con_last5_avg_pts, 3) AS pre_con_last5_avg_pts,
    ROUND(con.pre_con_last3_pace_gap_pct, 3) AS pre_con_last3_pace_gap_pct,
    ROUND(con.pre_con_last10_mech_dnf_rate, 3) AS pre_con_last10_mech_dnf_rate,
    ds.position AS pre_drv_champ_pos, ds.points AS pre_drv_champ_pts,
    -- post-qualifying features
    q.quali_position, q.quali_gap_pct, b.grid, b.is_pitlane_start,
    -- targets
    b.did_start           AS target_did_start,
    b.position_order      AS target_position_order,
    b.position            AS target_position,
    b.points_std          AS target_points_std,
    COALESCE(b.position = 1, 0)   AS target_win,
    COALESCE(b.position <= 3, 0)  AS target_podium,
    COALESCE(b.position <= 10, 0) AS target_top10,
    b.is_dnf              AS target_dnf,
    b.status_category     AS target_status_category
FROM base b
JOIN drv                  ON drv.result_key = b.result_key
JOIN con                  ON con.race_key = b.race_key AND con.constructor_key = b.constructor_key
JOIN dim_circuit c        ON c.circuit_key = b.circuit_key
JOIN dim_driver d         ON d.driver_key = b.driver_key
JOIN dim_constructor k    ON k.constructor_key = b.constructor_key
JOIN prev                 ON prev.race_key = b.race_key
LEFT JOIN fct_driver_standing ds ON ds.race_key = prev.prev_race_key AND ds.driver_key = b.driver_key
LEFT JOIN quali q         ON q.race_key = b.race_key AND q.driver_key = b.driver_key
ORDER BY b.race_date, b.round, b.position_order;

CREATE INDEX idx_ml_season ON ml_driver_race (season, round);

-- the slice most models should start from: modern hybrid-era races, drivers who started
DROP VIEW IF EXISTS ml_driver_race_modern;
CREATE VIEW ml_driver_race_modern AS
SELECT * FROM ml_driver_race WHERE season >= 2014 AND target_did_start = 1;
