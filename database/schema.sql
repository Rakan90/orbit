-- =====================================================================================
-- ORbit (SORRS V2), Team M042 — PostgreSQL schema
--   psql -d orbit -v ON_ERROR_STOP=1 -f schema.sql -f load.sql
-- Rules the database itself enforces:
--   C1  no column that could identify a patient can be added to the schema (event trigger)
--   C3  no room and no surgeon is ever in two places in the same plan (exclusion constraints)
--   C4  the overtime rate is fixed policy: rate rows can be added, never changed or deleted
--   audit log is append-only; every timing that counts for S3 / IS2 is stamped by the server
-- =====================================================================================
DROP SCHEMA IF EXISTS orbit CASCADE;
CREATE SCHEMA orbit;
SET search_path = orbit, public;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------------ reference data
CREATE TABLE department (
    id    SMALLSERIAL PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 2 AND 60)
);

CREATE TABLE room (
    id    TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9 _-]{1,20}$')
);

CREATE TABLE rate_policy (                      -- C4: fixed overtime pricing, append-only
    id               SERIAL PRIMARY KEY,
    valid_from       DATE NOT NULL UNIQUE,
    sar_per_minute   NUMERIC(8,2) NOT NULL CHECK (sar_per_minute > 0),
    multiplier       NUMERIC(4,2) NOT NULL CHECK (multiplier >= 1),
    note             TEXT
);

-- ------------------------------------------------------------------ accounts and audit
CREATE TYPE user_role AS ENUM ('coordinator', 'admin', 'viewer', 'staff');

CREATE TABLE app_user (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
    display_name  TEXT NOT NULL,
    role          user_role NOT NULL,
    surgeon_id    TEXT,                          -- staff accounts: the surgeon code they are
    password_hash TEXT NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((role = 'staff') = (surgeon_id IS NOT NULL))
);

CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    user_id     INT REFERENCES app_user(id),
    username    TEXT,
    action      TEXT NOT NULL,
    entity      TEXT,
    entity_id   TEXT,
    detail      TEXT,
    before      JSONB,
    after       JSONB
);

-- ------------------------------------------------------------------ booking sheets
-- A sheet is what the OR coordinator uploads (the 7 required V2 columns + optional ones),
-- plus the simulated reality V2 Step 1 adds (actual duration, turnover, manual actual start).
CREATE TABLE sheet (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    source_file  TEXT,
    imported_by  INT REFERENCES app_user(id),
    imported_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    is_active    BOOLEAN NOT NULL DEFAULT false,
    note         TEXT
);
CREATE UNIQUE INDEX one_active_sheet ON sheet (is_active) WHERE is_active;

CREATE TABLE sheet_surgeon (                    -- roster V2 derives from the sheet (or uploads)
    sheet_id       INT NOT NULL REFERENCES sheet(id) ON DELETE CASCADE,
    surgeon_id     TEXT NOT NULL CHECK (surgeon_id ~ '^[A-Za-z0-9_-]{2,20}$'),
    department_id  SMALLINT NOT NULL REFERENCES department(id),
    shift          CHAR(1) NOT NULL CHECK (shift IN ('A', 'B')),
    skill          TEXT NOT NULL CHECK (skill IN ('standard', 'advanced')),
    PRIMARY KEY (sheet_id, surgeon_id)
);

CREATE TABLE sheet_case (
    sheet_id               INT NOT NULL REFERENCES sheet(id) ON DELETE CASCADE,
    case_id                TEXT NOT NULL CHECK (case_id ~ '^[A-Za-z0-9_-]{1,20}$'),
    row_no                 INT NOT NULL,
    surgery_date           DATE NOT NULL,
    department_id          SMALLINT NOT NULL REFERENCES department(id),
    surgeon_id             TEXT NOT NULL,
    room_id                TEXT REFERENCES room(id),           -- NULL for an emergency added later
    booked_start_min       INT CHECK (booked_start_min BETWEEN 0 AND 1439),
    booked_duration_min    INT NOT NULL CHECK (booked_duration_min BETWEEN 5 AND 1440),
    is_emergency           BOOLEAN NOT NULL DEFAULT false,
    booking_date           DATE NOT NULL,
    skill_required         TEXT NOT NULL CHECK (skill_required IN ('standard', 'advanced')),
    -- simulated reality (V2 Step 1, seed 1): what the day really took
    actual_duration_min    INT NOT NULL CHECK (actual_duration_min > 0),
    turnover_min           INT NOT NULL CHECK (turnover_min BETWEEN 0 AND 120),
    waiting_days           INT NOT NULL CHECK (waiting_days >= 0),
    manual_actual_start_min INT,                                -- replay of the hand-built plan
    added_by_emergency     BOOLEAN NOT NULL DEFAULT false,      -- registered in ORbit, not on the sheet
    PRIMARY KEY (sheet_id, case_id),
    UNIQUE (sheet_id, row_no),
    FOREIGN KEY (sheet_id, surgeon_id) REFERENCES sheet_surgeon(sheet_id, surgeon_id),
    CHECK (booking_date <= surgery_date),
    CHECK (added_by_emergency OR (room_id IS NOT NULL AND booked_start_min IS NOT NULL AND manual_actual_start_min IS NOT NULL))
);

-- ------------------------------------------------------------------ plans (versions)
CREATE TYPE plan_kind   AS ENUM ('v2_baseline', 'optimized', 'repair');
CREATE TYPE plan_status AS ENUM ('proposed', 'published', 'superseded', 'rejected');
CREATE TYPE plan_mode   AS ENUM ('v2', 'booked');
CREATE TYPE item_status AS ENUM ('scheduled', 'emergency', 'deferred');

CREATE TABLE plan_version (
    id            SERIAL PRIMARY KEY,
    sheet_id      INT NOT NULL REFERENCES sheet(id) ON DELETE CASCADE,
    kind          plan_kind NOT NULL,
    mode          plan_mode NOT NULL,
    status        plan_status NOT NULL DEFAULT 'proposed',
    surgery_date  DATE,                          -- repair versions cover one day
    parent_id     INT REFERENCES plan_version(id),
    solve_s       JSONB NOT NULL DEFAULT '{}',   -- solver seconds per day (Spec 3 evidence)
    note          TEXT,
    created_by    INT REFERENCES app_user(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    published_by  INT REFERENCES app_user(id),
    published_at  TIMESTAMPTZ,
    CHECK ((kind = 'repair') = (surgery_date IS NOT NULL)),
    CHECK ((status IN ('published', 'superseded')) = (published_at IS NOT NULL))
);
-- at most one published whole-sheet plan per sheet, and one published repair per day
CREATE UNIQUE INDEX one_published_plan   ON plan_version (sheet_id) WHERE status = 'published' AND kind <> 'repair';
CREATE UNIQUE INDEX one_published_repair ON plan_version (sheet_id, surgery_date) WHERE status = 'published' AND kind = 'repair';

CREATE TABLE plan_item (
    version_id            INT NOT NULL REFERENCES plan_version(id) ON DELETE CASCADE,
    sheet_id              INT NOT NULL,
    case_id               TEXT NOT NULL,
    surgery_date          DATE NOT NULL,
    status                item_status NOT NULL,
    room_id               TEXT REFERENCES room(id),
    surgeon_id            TEXT,
    planned_start_min     INT,
    planned_duration_min  INT,
    turnover_min          INT NOT NULL,
    actual_start_min      INT,                  -- replay with the simulated durations
    PRIMARY KEY (version_id, case_id),
    FOREIGN KEY (sheet_id, case_id) REFERENCES sheet_case(sheet_id, case_id),
    CHECK ((status = 'deferred') = (room_id IS NULL)),
    CHECK (status = 'deferred' OR (surgeon_id IS NOT NULL AND planned_start_min IS NOT NULL AND planned_duration_min > 0)),
    -- C3, enforced here: spans of a room (operation + turnover) and of a surgeon (operation)
    room_span INT4RANGE GENERATED ALWAYS AS (
        CASE WHEN status <> 'deferred' THEN int4range(planned_start_min, planned_start_min + planned_duration_min + turnover_min) END) STORED,
    surgeon_span INT4RANGE GENERATED ALWAYS AS (
        CASE WHEN status <> 'deferred' THEN int4range(planned_start_min, planned_start_min + planned_duration_min) END) STORED,
    EXCLUDE USING gist (version_id WITH =, surgery_date WITH =, room_id WITH =, room_span WITH &&) WHERE (status <> 'deferred'),
    EXCLUDE USING gist (version_id WITH =, surgery_date WITH =, surgeon_id WITH =, surgeon_span WITH &&) WHERE (status <> 'deferred')
);
CREATE INDEX plan_item_day ON plan_item (version_id, surgery_date);

-- ------------------------------------------------------------------ engine runs and emergencies
CREATE TABLE engine_run (
    id           SERIAL PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('optimize', 'replan', 'simulate')),
    sheet_id     INT REFERENCES sheet(id) ON DELETE CASCADE,
    mode         plan_mode,
    started_at   TIMESTAMPTZ NOT NULL,
    finished_at  TIMESTAMPTZ,
    duration_ms  NUMERIC GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) STORED,
    version_id   INT REFERENCES plan_version(id) ON DELETE SET NULL,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    result       JSONB,
    error        TEXT,
    created_by   INT REFERENCES app_user(id)
);

CREATE TABLE emergency_event (
    id                  SERIAL PRIMARY KEY,
    sheet_id            INT NOT NULL REFERENCES sheet(id) ON DELETE CASCADE,
    surgery_date        DATE NOT NULL,
    case_id             TEXT NOT NULL,
    now_min             INT NOT NULL CHECK (now_min BETWEEN 0 AND 1439),
    department_id       SMALLINT NOT NULL REFERENCES department(id),
    surgeon_id          TEXT NOT NULL,
    expected_min        INT NOT NULL CHECK (expected_min BETWEEN 15 AND 400),
    registered_by       INT REFERENCES app_user(id),
    registered_at       TIMESTAMPTZ NOT NULL,     -- server receives the emergency (S3 and IS2 clocks start)
    engine_finished_at  TIMESTAMPTZ,              -- revised plan stored (S3 clock stops)
    engine_ms           NUMERIC GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (engine_finished_at - registered_at)) * 1000) STORED,
    version_id          INT REFERENCES plan_version(id) ON DELETE SET NULL,
    result              JSONB,
    published_at        TIMESTAMPTZ,
    published_by        INT REFERENCES app_user(id),
    first_seen_at       TIMESTAMPTZ,              -- first OR staff view after publish (IS2 clock stops)
    first_seen_by       INT REFERENCES app_user(id),
    end_to_end_ms       NUMERIC GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (first_seen_at - registered_at)) * 1000) STORED,
    FOREIGN KEY (sheet_id, case_id) REFERENCES sheet_case(sheet_id, case_id),
    CHECK (engine_finished_at IS NULL OR engine_finished_at >= registered_at),
    CHECK (published_at IS NULL OR published_at >= engine_finished_at),
    CHECK (first_seen_at IS NULL OR first_seen_at >= published_at)
);

-- ------------------------------------------------------------------ guards
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER rate_append_only  BEFORE UPDATE OR DELETE ON rate_policy FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- C1: refuse any column whose name suggests patient identity, anywhere in this schema
CREATE FUNCTION orbit_schema_gate() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT c.table_name, c.column_name FROM information_schema.columns c
              WHERE c.table_schema = 'orbit'
                AND c.column_name ~* '(patient|first_?name|last_?name|full_?name|mrn|medical_record|national_?id|iqama|passport|birth|dob|phone|mobile|email|address)'
    LOOP
        RAISE EXCEPTION 'Constraint 1: column %.% looks like patient-identifiable data and is not allowed', r.table_name, r.column_name;
    END LOOP;
END $$;
DROP EVENT TRIGGER IF EXISTS orbit_schema_gate;
CREATE EVENT TRIGGER orbit_schema_gate ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    EXECUTE FUNCTION orbit_schema_gate();

-- ------------------------------------------------------------------ the plan in force
-- per sheet and day: the published repair of that day, else the published whole-sheet plan
CREATE FUNCTION version_in_force(s INT, d DATE) RETURNS INT LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT id FROM plan_version WHERE sheet_id = s AND kind = 'repair' AND surgery_date = d AND status = 'published'),
        (SELECT id FROM plan_version WHERE sheet_id = s AND kind <> 'repair' AND status = 'published'))
$$;

-- C1 evidence view: identifier-looking columns in the schema (must be empty)
CREATE VIEW v_spec_c1 AS
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema = 'orbit'
   AND column_name ~* '(patient|first_?name|last_?name|full_?name|mrn|medical_record|national_?id|iqama|passport|birth|dob|phone|mobile|email|address)';
