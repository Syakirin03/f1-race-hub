-- ============================================================
-- F1 Race Hub: local SQLite warehouse
-- Normalised from the Jolpica (Ergast-compatible) F1 API.
-- Applied by ingest.py on every run; every statement is idempotent.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Dimensions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS circuits (
    circuit_id   TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    locality     TEXT,
    country      TEXT,
    lat          REAL,
    lng          REAL,
    url          TEXT
);

CREATE TABLE IF NOT EXISTS drivers (
    driver_id         TEXT PRIMARY KEY,
    code              TEXT,                    -- VER, LEC, ...
    permanent_number  TEXT,
    given_name        TEXT NOT NULL,
    family_name       TEXT NOT NULL,
    date_of_birth     TEXT,                    -- yyyy-mm-dd
    nationality       TEXT,
    url               TEXT
);

CREATE TABLE IF NOT EXISTS constructors (
    constructor_id  TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    nationality     TEXT,
    url             TEXT
);

CREATE TABLE IF NOT EXISTS races (
    season      INTEGER NOT NULL,
    round       INTEGER NOT NULL,
    race_name   TEXT    NOT NULL,
    circuit_id  TEXT    NOT NULL REFERENCES circuits (circuit_id),
    date        TEXT    NOT NULL,              -- yyyy-mm-dd
    time        TEXT,                          -- hh:mm:ssZ (UTC)
    url         TEXT,
    PRIMARY KEY (season, round)
);

-- ------------------------------------------------------------
-- Facts
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS results (
    season          INTEGER NOT NULL,
    round           INTEGER NOT NULL,
    driver_id       TEXT    NOT NULL REFERENCES drivers (driver_id),
    constructor_id  TEXT    NOT NULL REFERENCES constructors (constructor_id),
    number          TEXT,
    position        INTEGER,                   -- classified order; every entry has one
    position_text   TEXT,                      -- "1".."22", or R / D / E / W / F / N
    points          REAL    NOT NULL DEFAULT 0,
    grid            INTEGER,                   -- 0 = pit-lane start
    laps            INTEGER,
    status          TEXT,                      -- Finished, +1 Lap, Retired, ...
    time_millis     INTEGER,                   -- lead-lap finishers only
    time_text       TEXT,                      -- "1:42:00.785" or gap "+7.335"
    fl_rank         INTEGER,                   -- fastest-lap ranking
    fl_lap          INTEGER,
    fl_time         TEXT,
    fl_speed        TEXT,
    fl_speed_units  TEXT,
    PRIMARY KEY (season, round, driver_id),
    FOREIGN KEY (season, round) REFERENCES races (season, round)
);
CREATE INDEX IF NOT EXISTS idx_results_driver ON results (driver_id, season, round);

CREATE TABLE IF NOT EXISTS qualifying (
    season          INTEGER NOT NULL,
    round           INTEGER NOT NULL,
    driver_id       TEXT    NOT NULL REFERENCES drivers (driver_id),
    constructor_id  TEXT    NOT NULL REFERENCES constructors (constructor_id),
    number          TEXT,
    position        INTEGER,
    q1              TEXT,
    q2              TEXT,
    q3              TEXT,
    PRIMARY KEY (season, round, driver_id),
    FOREIGN KEY (season, round) REFERENCES races (season, round)
);

CREATE TABLE IF NOT EXISTS laps (
    season     INTEGER NOT NULL,
    round      INTEGER NOT NULL,
    lap        INTEGER NOT NULL,
    driver_id  TEXT    NOT NULL,
    position   INTEGER,                        -- running position at the end of the lap
    time_text  TEXT,                           -- "1:42.290"
    time_ms    INTEGER,                        -- 102290
    PRIMARY KEY (season, round, lap, driver_id),
    FOREIGN KEY (season, round) REFERENCES races (season, round)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pit_stops (
    season         INTEGER NOT NULL,
    round          INTEGER NOT NULL,
    driver_id      TEXT    NOT NULL,
    stop           INTEGER NOT NULL,
    lap            INTEGER,
    time_of_day    TEXT,                       -- local clock time of the stop
    duration_text  TEXT,                       -- "24.048"
    duration_ms    INTEGER,
    PRIMARY KEY (season, round, driver_id, stop),
    FOREIGN KEY (season, round) REFERENCES races (season, round)
);

CREATE TABLE IF NOT EXISTS driver_standings (
    season         INTEGER NOT NULL,
    round          INTEGER NOT NULL,           -- standings after this round
    driver_id      TEXT    NOT NULL REFERENCES drivers (driver_id),
    position       INTEGER,
    position_text  TEXT,
    points         REAL    NOT NULL DEFAULT 0, -- includes sprint points
    wins           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (season, round, driver_id)
);

-- A driver can race for more than one team in a season.
CREATE TABLE IF NOT EXISTS driver_standing_teams (
    season          INTEGER NOT NULL,
    round           INTEGER NOT NULL,
    driver_id       TEXT    NOT NULL,
    seq             INTEGER NOT NULL,          -- API order; the last entry is the current team
    constructor_id  TEXT    NOT NULL REFERENCES constructors (constructor_id),
    PRIMARY KEY (season, round, driver_id, seq)
);

-- ------------------------------------------------------------
-- Pipeline bookkeeping
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_log (
    season     INTEGER NOT NULL,
    round      INTEGER NOT NULL,               -- 0 for season-wide datasets
    dataset    TEXT    NOT NULL,               -- schedule, results, qualifying, standings, pitstops, laps
    rows       INTEGER NOT NULL,
    synced_at  TEXT    NOT NULL,               -- UTC ISO-8601
    PRIMARY KEY (season, round, dataset)
);

CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT
);

-- ------------------------------------------------------------
-- Analysis views (rebuilt on every run, so edits here apply)
-- ------------------------------------------------------------
DROP VIEW IF EXISTS v_results;
CREATE VIEW v_results AS
SELECT x.season, x.round, r.race_name, r.date,
       d.given_name || ' ' || d.family_name AS driver, d.code,
       k.name AS team, x.grid, x.position, x.position_text,
       x.points, x.status, x.laps
FROM results x
JOIN races r        ON r.season = x.season AND r.round = x.round
JOIN drivers d      ON d.driver_id = x.driver_id
JOIN constructors k ON k.constructor_id = x.constructor_id;

DROP VIEW IF EXISTS v_driver_season;
CREATE VIEW v_driver_season AS
SELECT x.season,
       d.given_name || ' ' || d.family_name                    AS driver,
       d.code,
       COUNT(*)                                                AS races,
       SUM(x.position = 1 AND x.position_text GLOB '[0-9]*')   AS wins,
       SUM(x.position <= 3 AND x.position_text GLOB '[0-9]*')  AS podiums,
       SUM(x.points > 0)                                       AS points_finishes,
       SUM(x.position_text NOT GLOB '[0-9]*')                  AS not_classified,
       SUM(x.points)                                           AS race_points,
       ROUND(AVG(CASE WHEN x.grid > 0 AND x.position_text GLOB '[0-9]*'
                      THEN x.grid - x.position END), 2)        AS avg_places_gained
FROM results x
JOIN drivers d ON d.driver_id = x.driver_id
GROUP BY x.season, x.driver_id;

DROP VIEW IF EXISTS v_race_pace;
CREATE VIEW v_race_pace AS
SELECT l.season, l.round, l.driver_id,
       COUNT(*)                AS laps,
       MIN(l.time_ms)          AS best_lap_ms,
       ROUND(AVG(l.time_ms))   AS avg_lap_ms
FROM laps l
GROUP BY l.season, l.round, l.driver_id;

DROP VIEW IF EXISTS v_pit_summary;
CREATE VIEW v_pit_summary AS
SELECT p.season, p.round, p.driver_id,
       COUNT(*)            AS stops,
       MIN(p.duration_ms)  AS fastest_stop_ms,
       SUM(p.duration_ms)  AS total_pit_ms
FROM pit_stops p
GROUP BY p.season, p.round, p.driver_id;

DROP VIEW IF EXISTS v_championship;
CREATE VIEW v_championship AS
SELECT s.season, s.round, r.race_name,
       d.given_name || ' ' || d.family_name AS driver, d.code,
       s.position, s.points, s.wins
FROM driver_standings s
JOIN races r   ON r.season = s.season AND r.round = s.round
JOIN drivers d ON d.driver_id = s.driver_id;
