-- ============================================================
-- live.* (data/f1.db, synced from the API by ingest.py) -> silver,
-- for seasons newer than the CSV history (:csv_max).
-- Entities are matched on their natural keys (driver_ref, constructor_ref,
-- circuit_ref); new ones (rookies, Audi, Cadillac, ...) get new keys.
-- ============================================================

INSERT INTO dim_season (season, url, source)
SELECT DISTINCT season, NULL, 'live' FROM live.races WHERE season > :csv_max;

INSERT INTO dim_circuit (circuit_ref, name, locality, country, lat, lng, url)
SELECT circuit_id, TRIM(name), TRIM(locality), TRIM(country), lat, lng, url FROM live.circuits
WHERE circuit_id NOT IN (SELECT circuit_ref FROM dim_circuit);

INSERT INTO dim_driver (driver_ref, code, permanent_number, given_name, family_name, full_name,
                        date_of_birth, nationality, url)
SELECT driver_id, code, CAST(permanent_number AS INTEGER), TRIM(given_name), TRIM(family_name),
       TRIM(given_name) || ' ' || TRIM(family_name), date_of_birth, TRIM(nationality), url
FROM live.drivers WHERE driver_id NOT IN (SELECT driver_ref FROM dim_driver);

INSERT INTO dim_constructor (constructor_ref, name, nationality, url)
SELECT constructor_id, TRIM(name), TRIM(nationality), url FROM live.constructors
WHERE constructor_id NOT IN (SELECT constructor_ref FROM dim_constructor);

INSERT INTO dim_status (status, category)
SELECT DISTINCT status, status_category(status) FROM live.results
WHERE status IS NOT NULL AND status NOT IN (SELECT status FROM dim_status);

INSERT INTO dim_race (season, round, race_name, circuit_key, race_date, race_time, has_sprint, url, source)
SELECT r.season, r.round, r.race_name, c.circuit_key, r.date, RTRIM(r.time, 'Z'), NULL, r.url, 'live'
FROM live.races r JOIN dim_circuit c ON c.circuit_ref = r.circuit_id
WHERE r.season > :csv_max;

CREATE TEMP VIEW live_race AS
SELECT race_key, season, round FROM dim_race WHERE source = 'live';

INSERT INTO fct_result (race_key, driver_key, constructor_key, status_key, car_number, grid_raw, position,
                        position_text, position_order, points, laps, race_time_ms, race_time_text,
                        fastest_lap_lap, fastest_lap_rank, fastest_lap_ms, fastest_lap_kph, source)
SELECT x.race_key, d.driver_key, k.constructor_key, s.status_key, r.number, r.grid,
       CASE WHEN r.position_text GLOB '[0-9]*' THEN r.position END,   -- classified only, like the CSV
       r.position_text, r.position, r.points, r.laps, r.time_millis, r.time_text,
       r.fl_lap, r.fl_rank, to_ms(r.fl_time), CAST(r.fl_speed AS REAL), 'live'
FROM live.results r
JOIN live_race x         ON x.season = r.season AND x.round = r.round
JOIN dim_driver d        ON d.driver_ref = r.driver_id
JOIN dim_constructor k   ON k.constructor_ref = r.constructor_id
JOIN dim_status s        ON s.status = r.status;

INSERT INTO fct_qualifying (race_key, driver_key, constructor_key, car_number, position, q1_ms, q2_ms, q3_ms, source)
SELECT x.race_key, d.driver_key, k.constructor_key, q.number, q.position,
       to_ms(q.q1), to_ms(q.q2), to_ms(q.q3), 'live'
FROM live.qualifying q
JOIN live_race x         ON x.season = q.season AND x.round = q.round
JOIN dim_driver d        ON d.driver_ref = q.driver_id
JOIN dim_constructor k   ON k.constructor_ref = q.constructor_id;

INSERT INTO lap_stage (race_key, driver_key, lap, position, lap_ms)
SELECT x.race_key, d.driver_key, l.lap, l.position, l.time_ms
FROM live.laps l
JOIN live_race x   ON x.season = l.season AND x.round = l.round
JOIN dim_driver d  ON d.driver_ref = l.driver_id
WHERE l.time_ms IS NOT NULL;

INSERT INTO fct_pit_stop (race_key, driver_key, stop, lap, time_of_day, duration_ms, is_long_stop)
SELECT x.race_key, d.driver_key, p.stop, p.lap, p.time_of_day, p.duration_ms, 0
FROM live.pit_stops p
JOIN live_race x   ON x.season = p.season AND x.round = p.round
JOIN dim_driver d  ON d.driver_ref = p.driver_id;

INSERT INTO fct_driver_standing (race_key, driver_key, position, position_text, points, wins)
SELECT x.race_key, d.driver_key, s.position, s.position_text, s.points, s.wins
FROM live.driver_standings s
JOIN live_race x   ON x.season = s.season AND x.round = s.round
JOIN dim_driver d  ON d.driver_ref = s.driver_id;
