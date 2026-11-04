-- ============================================================
-- legacy.* (data/warehouse_legacy.db, the raw_* tables of the previous CSV
-- delivery) -> silver, for detail the current CSVs dropped:
--   * failed-to-qualify entries (positionText 'F'), and the drivers,
--     constructors and statuses that exist only because of them
--   * 2023-24 retirement reasons and lap counts, now 'Retired' / 'Lapped'
-- Rows are matched on natural keys because the delivery renumbered every ID.
-- 'Did not start' in the CSV is kept: those cars never took the start.
-- ============================================================

CREATE TEMP TABLE legacy_result AS
SELECT x.race_key, clean(d.driverRef) AS driver_ref, clean(c.constructorRef) AS constructor_ref,
       clean(s.status) AS status, r.*
FROM legacy.raw_results r
JOIN legacy.raw_races lr       ON lr.raceId = r.raceId
JOIN dim_race x                ON x.season = CAST(lr.year AS INTEGER) AND x.round = CAST(lr.round AS INTEGER)
JOIN legacy.raw_drivers d      ON d.driverId = r.driverId
JOIN legacy.raw_constructors c ON c.constructorId = r.constructorId
JOIN legacy.raw_status s       ON s.statusId = r.statusId;

CREATE TEMP TABLE legacy_sprint AS
SELECT x.race_key, clean(d.driverRef) AS driver_ref, clean(s.status) AS status
FROM legacy.raw_sprint_results r
JOIN legacy.raw_races lr   ON lr.raceId = r.raceId
JOIN dim_race x            ON x.season = CAST(lr.year AS INTEGER) AND x.round = CAST(lr.round AS INTEGER)
JOIN legacy.raw_drivers d  ON d.driverId = r.driverId
JOIN legacy.raw_status s   ON s.statusId = r.statusId;

CREATE TEMP TABLE legacy_missing AS
SELECT l.* FROM legacy_result l
WHERE clean(l.positionText) = 'F'
  AND NOT EXISTS (SELECT 1 FROM fct_result r JOIN dim_driver d USING (driver_key)
                  WHERE r.race_key = l.race_key AND d.driver_ref = l.driver_ref);

INSERT INTO dim_driver (driver_ref, code, permanent_number, given_name, family_name, full_name,
                        date_of_birth, nationality, url)
SELECT clean(driverRef), clean(code), CAST(clean(number) AS INTEGER), clean(forename), clean(surname),
       clean(forename) || ' ' || clean(surname), clean(dob), clean(nationality), clean(url)
FROM legacy.raw_drivers
WHERE clean(driverRef) IN (SELECT driver_ref FROM legacy_missing)
  AND clean(driverRef) NOT IN (SELECT driver_ref FROM dim_driver);

INSERT INTO dim_constructor (constructor_ref, name, nationality, url)
SELECT clean(constructorRef), clean(name), clean(nationality), clean(url)
FROM legacy.raw_constructors
WHERE clean(constructorRef) IN (SELECT constructor_ref FROM legacy_missing)
  AND clean(constructorRef) NOT IN (SELECT constructor_ref FROM dim_constructor);

INSERT INTO dim_status (status, category)
SELECT status, status_category(status) FROM (
    SELECT status FROM legacy_missing
    UNION SELECT status FROM legacy_result WHERE race_key IN (SELECT race_key FROM dim_race WHERE season >= 2023)
    UNION SELECT status FROM legacy_sprint)
WHERE status NOT IN (SELECT status FROM dim_status);

INSERT INTO fct_result (race_key, driver_key, constructor_key, status_key, car_number, grid_raw,
                        position, position_text, position_order, points, laps, race_time_ms, race_time_text,
                        fastest_lap_lap, fastest_lap_rank, fastest_lap_ms, fastest_lap_kph, source)
SELECT l.race_key, d.driver_key, k.constructor_key, s.status_key, clean(l.number), CAST(clean(l.grid) AS INTEGER),
       CAST(clean(l.position) AS INTEGER), clean(l.positionText), CAST(l.positionOrder AS INTEGER),
       CAST(clean(l.points) AS REAL), CAST(clean(l.laps) AS INTEGER), CAST(clean(l.milliseconds) AS INTEGER),
       clean(l.time), CAST(clean(l.fastestLap) AS INTEGER), CAST(clean(l.rank) AS INTEGER),
       to_ms(clean(l.fastestLapTime)), CAST(clean(l.fastestLapSpeed) AS REAL), 'legacy'
FROM legacy_missing l
JOIN dim_driver d      ON d.driver_ref = l.driver_ref
JOIN dim_constructor k ON k.constructor_ref = l.constructor_ref
JOIN dim_status s      ON s.status = l.status;

UPDATE fct_result SET status_key = s.status_key
FROM legacy_result l
JOIN dim_driver d ON d.driver_ref = l.driver_ref
JOIN dim_status s ON s.status = l.status
WHERE l.race_key = fct_result.race_key AND d.driver_key = fct_result.driver_key
  AND CAST(l.positionOrder AS INTEGER) = fct_result.position_order   -- shared drives: one row per entry
  AND l.status NOT IN ('Retired', 'Lapped')
  AND fct_result.status_key IN (SELECT status_key FROM dim_status WHERE status IN ('Retired', 'Lapped'));

UPDATE fct_sprint_result SET status_key = s.status_key
FROM legacy_sprint l
JOIN dim_driver d ON d.driver_ref = l.driver_ref
JOIN dim_status s ON s.status = l.status
WHERE l.race_key = fct_sprint_result.race_key AND d.driver_key = fct_sprint_result.driver_key
  AND l.status NOT IN ('Retired', 'Lapped')
  AND fct_sprint_result.status_key IN (SELECT status_key FROM dim_status WHERE status IN ('Retired', 'Lapped'));
