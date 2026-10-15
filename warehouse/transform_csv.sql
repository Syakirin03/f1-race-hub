-- ============================================================
-- raw_* (CSV as delivered) -> silver.
-- clean(x): trims text and turns the dump's null markers (\N, '') into NULL.
-- to_ms(t): '1:26.572' -> 86572.  status_category(s): groups the 139 statuses.
-- ============================================================

INSERT INTO dim_season (season, url, source)
SELECT CAST(year AS INTEGER), clean(url), 'csv' FROM raw_seasons;

INSERT INTO dim_circuit (circuit_key, circuit_ref, name, locality, country, lat, lng, altitude_m, url)
SELECT CAST(circuitId AS INTEGER), clean(circuitRef), clean(name), clean(location), clean(country),
       CAST(clean(lat) AS REAL), CAST(clean(lng) AS REAL), CAST(clean(alt) AS INTEGER), clean(url)
FROM raw_circuits;

INSERT INTO dim_driver (driver_key, driver_ref, code, permanent_number, given_name, family_name,
                        full_name, date_of_birth, nationality, url)
SELECT CAST(driverId AS INTEGER), clean(driverRef), clean(code), CAST(clean(number) AS INTEGER),
       clean(forename), clean(surname), clean(forename) || ' ' || clean(surname),
       clean(dob), clean(nationality), clean(url)
FROM raw_drivers;

INSERT INTO dim_constructor (constructor_key, constructor_ref, name, nationality, url)
SELECT CAST(constructorId AS INTEGER), clean(constructorRef), clean(name), clean(nationality), clean(url)
FROM raw_constructors;

INSERT INTO dim_status (status_key, status, category)
SELECT CAST(statusId AS INTEGER), clean(status), status_category(clean(status)) FROM raw_status;

INSERT INTO dim_race (race_key, season, round, race_name, circuit_key, race_date, race_time, has_sprint, url, source)
SELECT CAST(raceId AS INTEGER), CAST(year AS INTEGER), CAST(round AS INTEGER), clean(name),
       CAST(circuitId AS INTEGER), clean(date), clean(time),
       (clean(sprint_date) IS NOT NULL OR raceId IN (SELECT raceId FROM raw_sprint_results)),
       clean(url), 'csv'
FROM raw_races;

INSERT INTO fct_result (result_key, race_key, driver_key, constructor_key, status_key, car_number, grid_raw,
                        position, position_text, position_order, points, laps, race_time_ms, race_time_text,
                        fastest_lap_lap, fastest_lap_rank, fastest_lap_ms, fastest_lap_kph, source)
SELECT CAST(resultId AS INTEGER), CAST(raceId AS INTEGER), CAST(driverId AS INTEGER),
       CAST(constructorId AS INTEGER), CAST(statusId AS INTEGER), clean(number), CAST(clean(grid) AS INTEGER),
       CAST(clean(position) AS INTEGER), clean(positionText), CAST(positionOrder AS INTEGER),
       CAST(clean(points) AS REAL), CAST(clean(laps) AS INTEGER), CAST(clean(milliseconds) AS INTEGER),
       clean(time), CAST(clean(fastestLap) AS INTEGER), CAST(clean(rank) AS INTEGER),
       to_ms(clean(fastestLapTime)), CAST(clean(fastestLapSpeed) AS REAL), 'csv'
FROM raw_results;

INSERT INTO fct_sprint_result (sprint_result_key, race_key, driver_key, constructor_key, status_key, grid, position,
                               position_text, position_order, points, laps, race_time_ms, fastest_lap_ms)
SELECT CAST(resultId AS INTEGER), CAST(raceId AS INTEGER), CAST(driverId AS INTEGER), CAST(constructorId AS INTEGER),
       CAST(statusId AS INTEGER), CAST(clean(grid) AS INTEGER), CAST(clean(position) AS INTEGER),
       clean(positionText), CAST(positionOrder AS INTEGER), CAST(clean(points) AS REAL),
       CAST(clean(laps) AS INTEGER), CAST(clean(milliseconds) AS INTEGER), to_ms(clean(fastestLapTime))
FROM raw_sprint_results;

INSERT INTO fct_qualifying (race_key, driver_key, constructor_key, car_number, position, q1_ms, q2_ms, q3_ms, source)
SELECT CAST(raceId AS INTEGER), CAST(driverId AS INTEGER), CAST(constructorId AS INTEGER), clean(number),
       CAST(clean(position) AS INTEGER), to_ms(clean(q1)), to_ms(clean(q2)), to_ms(clean(q3)), 'csv'
FROM raw_qualifying;

-- laps go to a staging table first; flags need every lap of the race (see finalize.sql)
CREATE TEMP TABLE lap_stage (race_key INTEGER, driver_key INTEGER, lap INTEGER, position INTEGER, lap_ms INTEGER);
INSERT INTO lap_stage
SELECT CAST(raceId AS INTEGER), CAST(driverId AS INTEGER), CAST(lap AS INTEGER),
       CAST(clean(position) AS INTEGER), CAST(clean(milliseconds) AS INTEGER)
FROM raw_lap_times;

INSERT INTO fct_pit_stop (race_key, driver_key, stop, lap, time_of_day, duration_ms, is_long_stop)
SELECT CAST(raceId AS INTEGER), CAST(driverId AS INTEGER), CAST(stop AS INTEGER), CAST(clean(lap) AS INTEGER),
       clean(time), COALESCE(CAST(clean(milliseconds) AS INTEGER), to_ms(clean(duration))), 0
FROM raw_pit_stops;

INSERT INTO fct_driver_standing (race_key, driver_key, position, position_text, points, wins)
SELECT CAST(raceId AS INTEGER), CAST(driverId AS INTEGER), CAST(clean(position) AS INTEGER),
       clean(positionText), CAST(clean(points) AS REAL), CAST(clean(wins) AS INTEGER)
FROM raw_driver_standings;

INSERT INTO fct_constructor_standing (constructor_standing_key, race_key, constructor_key, position,
                                      position_text, points, wins)
SELECT CAST(constructorStandingsId AS INTEGER), CAST(raceId AS INTEGER), CAST(constructorId AS INTEGER),
       CAST(clean(position) AS INTEGER), clean(positionText), CAST(clean(points) AS REAL), CAST(clean(wins) AS INTEGER)
FROM raw_constructor_standings;

INSERT INTO fct_constructor_result (constructor_result_key, race_key, constructor_key, points, status)
SELECT CAST(constructorResultsId AS INTEGER), CAST(raceId AS INTEGER), CAST(constructorId AS INTEGER),
       CAST(clean(points) AS REAL), clean(status)
FROM raw_constructor_results;
