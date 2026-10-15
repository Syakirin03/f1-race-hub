-- ============================================================
-- F1 data warehouse: silver layer (cleaned star schema)
-- Dimensions describe things (drivers, teams, races); facts record
-- what happened (results, laps, stops). Keys are integers; the *_ref
-- columns are the natural keys shared with the live API / f1.db.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------------- dimensions ----------------
CREATE TABLE dim_season (
    season   INTEGER PRIMARY KEY,
    url      TEXT,
    source   TEXT NOT NULL                 -- 'csv' (historical dump) or 'live' (data/f1.db)
);

CREATE TABLE dim_circuit (
    circuit_key  INTEGER PRIMARY KEY,
    circuit_ref  TEXT NOT NULL UNIQUE,     -- e.g. 'monaco'
    name         TEXT NOT NULL,
    locality     TEXT,
    country      TEXT,
    lat          REAL,
    lng          REAL,
    altitude_m   INTEGER,
    url          TEXT
);

CREATE TABLE dim_driver (
    driver_key        INTEGER PRIMARY KEY,
    driver_ref        TEXT NOT NULL UNIQUE,  -- e.g. 'max_verstappen'
    code              TEXT,
    permanent_number  INTEGER,
    given_name        TEXT NOT NULL,
    family_name       TEXT NOT NULL,
    full_name         TEXT NOT NULL,
    date_of_birth     TEXT,
    nationality       TEXT,
    url               TEXT
);

CREATE TABLE dim_constructor (
    constructor_key  INTEGER PRIMARY KEY,
    constructor_ref  TEXT NOT NULL UNIQUE,   -- e.g. 'red_bull'
    name             TEXT NOT NULL,
    nationality      TEXT,
    url              TEXT
);

CREATE TABLE dim_status (
    status_key  INTEGER PRIMARY KEY,
    status      TEXT NOT NULL UNIQUE,        -- as reported: 'Gearbox', '+1 Lap', ...
    category    TEXT NOT NULL                -- finished | lapped | mechanical | accident | driver |
                                             -- disqualified | did_not_qualify | did_not_start | retired_other
);

CREATE TABLE dim_race (
    race_key     INTEGER PRIMARY KEY,
    season       INTEGER NOT NULL REFERENCES dim_season (season),
    round        INTEGER NOT NULL,
    race_seq     INTEGER,                    -- chronological order across all seasons (for window functions)
    race_name    TEXT NOT NULL,
    circuit_key  INTEGER NOT NULL REFERENCES dim_circuit (circuit_key),
    race_date    TEXT NOT NULL,              -- yyyy-mm-dd
    race_time    TEXT,                       -- hh:mm:ss UTC
    has_sprint   INTEGER,                    -- NULL = unknown
    url          TEXT,
    source       TEXT NOT NULL,
    UNIQUE (season, round)
);

-- ---------------- facts ----------------
CREATE TABLE fct_result (
    result_key        INTEGER PRIMARY KEY,
    race_key          INTEGER NOT NULL REFERENCES dim_race (race_key),
    driver_key        INTEGER NOT NULL REFERENCES dim_driver (driver_key),
    constructor_key   INTEGER NOT NULL REFERENCES dim_constructor (constructor_key),
    status_key        INTEGER NOT NULL REFERENCES dim_status (status_key),
    car_number        TEXT,
    grid_raw          INTEGER,               -- as delivered (0 = pit lane OR did not start)
    grid              INTEGER,               -- cleaned: NULL when not on the grid
    position          INTEGER,               -- classified finishing position, NULL if not classified
    position_text     TEXT,                  -- '1'.. or R/D/E/W/F/N
    position_order    INTEGER NOT NULL,      -- full order incl. non-classified (always set)
    points            REAL NOT NULL,         -- points as awarded in that era
    points_std        INTEGER,               -- the same result scored 25-18-15-12-10-8-6-4-2-1
    laps              INTEGER,
    race_time_ms      INTEGER,
    race_time_text    TEXT,
    fastest_lap_lap   INTEGER,
    fastest_lap_rank  INTEGER,
    fastest_lap_ms    INTEGER,
    fastest_lap_kph   REAL,
    did_start         INTEGER,               -- 0 for DNQ / DNS / withdrawn
    is_pitlane_start  INTEGER,
    is_classified     INTEGER,
    is_finished       INTEGER,               -- took the flag (finished or lapped)
    is_dnf            INTEGER,               -- started, didn't finish, not disqualified
    is_shared_drive   INTEGER DEFAULT 0,     -- 1950s-70s: driver had two entries in one race
    source            TEXT NOT NULL
);
CREATE INDEX idx_result_race   ON fct_result (race_key);
CREATE INDEX idx_result_driver ON fct_result (driver_key, race_key);

CREATE TABLE fct_sprint_result (
    sprint_result_key  INTEGER PRIMARY KEY,
    race_key           INTEGER NOT NULL REFERENCES dim_race (race_key),
    driver_key         INTEGER NOT NULL REFERENCES dim_driver (driver_key),
    constructor_key    INTEGER NOT NULL REFERENCES dim_constructor (constructor_key),
    status_key         INTEGER NOT NULL REFERENCES dim_status (status_key),
    grid               INTEGER,
    position           INTEGER,
    position_text      TEXT,
    position_order     INTEGER,
    points             REAL NOT NULL,
    laps               INTEGER,
    race_time_ms       INTEGER,
    fastest_lap_ms     INTEGER
);

CREATE TABLE fct_qualifying (
    race_key         INTEGER NOT NULL REFERENCES dim_race (race_key),
    driver_key       INTEGER NOT NULL REFERENCES dim_driver (driver_key),
    constructor_key  INTEGER NOT NULL REFERENCES dim_constructor (constructor_key),
    car_number       TEXT,
    position         INTEGER,
    q1_ms            INTEGER,
    q2_ms            INTEGER,
    q3_ms            INTEGER,
    best_ms          INTEGER,                -- fastest of Q1-Q3
    source           TEXT NOT NULL,
    PRIMARY KEY (race_key, driver_key)
);

CREATE TABLE fct_lap (
    race_key        INTEGER NOT NULL REFERENCES dim_race (race_key),
    driver_key      INTEGER NOT NULL REFERENCES dim_driver (driver_key),
    lap             INTEGER NOT NULL,
    position        INTEGER,
    lap_ms          INTEGER NOT NULL,
    is_green_lap    INTEGER NOT NULL,        -- not lap 1 and within 107% of the driver's best that race
    is_extreme_lap  INTEGER NOT NULL,        -- over 2x the race's median lap (red flag, long stop)
    PRIMARY KEY (race_key, driver_key, lap)
) WITHOUT ROWID;

CREATE TABLE fct_driver_race_pace (          -- one row per driver per race, aggregated from fct_lap
    race_key         INTEGER NOT NULL REFERENCES dim_race (race_key),
    driver_key       INTEGER NOT NULL REFERENCES dim_driver (driver_key),
    laps             INTEGER NOT NULL,
    green_laps       INTEGER NOT NULL,
    best_lap_ms      INTEGER,
    median_green_ms  REAL,
    pace_gap_pct     REAL,                   -- % slower than the race's quickest typical pace (>= 5 green laps)
    PRIMARY KEY (race_key, driver_key)
);

CREATE TABLE fct_pit_stop (
    race_key       INTEGER NOT NULL REFERENCES dim_race (race_key),
    driver_key     INTEGER NOT NULL REFERENCES dim_driver (driver_key),
    stop           INTEGER NOT NULL,
    lap            INTEGER,
    time_of_day    TEXT,
    duration_ms    INTEGER,
    is_long_stop   INTEGER NOT NULL,         -- over 2 minutes: red-flag repairs, not a real stop
    PRIMARY KEY (race_key, driver_key, stop)
);

CREATE TABLE fct_driver_standing (           -- championship table after each race
    race_key       INTEGER NOT NULL REFERENCES dim_race (race_key),
    driver_key     INTEGER NOT NULL REFERENCES dim_driver (driver_key),
    position       INTEGER,
    position_text  TEXT,
    points         REAL NOT NULL,
    wins           INTEGER NOT NULL,
    PRIMARY KEY (race_key, driver_key)
);

CREATE TABLE fct_constructor_standing (
    constructor_standing_key  INTEGER PRIMARY KEY,
    race_key         INTEGER NOT NULL REFERENCES dim_race (race_key),
    constructor_key  INTEGER NOT NULL REFERENCES dim_constructor (constructor_key),
    position         INTEGER,
    position_text    TEXT,
    points           REAL NOT NULL,
    wins             INTEGER NOT NULL
);
CREATE INDEX idx_con_standing ON fct_constructor_standing (race_key, constructor_key);

CREATE TABLE fct_constructor_result (
    constructor_result_key  INTEGER PRIMARY KEY,
    race_key         INTEGER NOT NULL REFERENCES dim_race (race_key),
    constructor_key  INTEGER NOT NULL REFERENCES dim_constructor (constructor_key),
    points           REAL NOT NULL,
    status           TEXT
);

-- ---------------- data-quality log ----------------
CREATE TABLE dq_log (
    step    TEXT NOT NULL,                   -- raw | clean | live | integrity
    check_  TEXT NOT NULL,
    rows    INTEGER,
    note    TEXT
);
