-- =====================================================================================
-- ORbit: load V2's data exactly as the V2 pack produced it (run from the database folder)
--   data/booking_sheet_example.csv  the 10-day booking sheet (input)
--   data/sorrs_simulated.csv        V2 Step 1: simulated actual durations, turnover, manual replay
--   data/sorrs_optimized.csv        V2 Step 2: ORbit's plan (published as the V2 baseline)
--   data/v2_roster.csv              surgeons as V2 derives them from the sheet
--   data/v2_solve_seconds.csv       solver seconds per day from V2's run (Spec 3 evidence)
-- =====================================================================================
SET search_path = orbit, public;

INSERT INTO rate_policy (valid_from, sar_per_minute, multiplier, note)
VALUES ('2026-01-01', 19.30, 1.5, 'Surgeon, anaesthetist and two nurses, loaded, at 1.5x (V2 TEAM_RATE_SAR_MIN)');

CREATE TEMP TABLE t_sim (
    case_id TEXT, surgery_date DATE, department TEXT, surgeon_id TEXT, room TEXT, booked_start TEXT,
    booked_duration_min INT, is_emergency INT, booking_date DATE, skill_required TEXT, booked_start_min INT,
    actual_duration_min INT, turnover_min INT, waiting_days INT, actual_start_min NUMERIC, actual_end_min NUMERIC,
    actual_start TEXT, actual_end TEXT, overrun_min INT);
\copy t_sim FROM 'data/sorrs_simulated.csv' WITH (FORMAT csv, HEADER true)
ALTER TABLE t_sim ADD COLUMN row_no SERIAL;

CREATE TEMP TABLE t_opt (
    case_id TEXT, surgery_date DATE, department TEXT, booked_start TEXT, booked_duration_min INT, is_emergency INT,
    booking_date DATE, skill_required TEXT, booked_start_min INT, actual_duration_min INT, turnover_min INT,
    waiting_days INT, actual_start_min NUMERIC, actual_end_min NUMERIC, actual_start TEXT, actual_end TEXT,
    overrun_min INT, room TEXT, surgeon_id TEXT, planned_start_min NUMERIC, planned_duration_min NUMERIC,
    status TEXT, planned_start TEXT);
\copy t_opt FROM 'data/sorrs_optimized.csv' WITH (FORMAT csv, HEADER true)

CREATE TEMP TABLE t_roster (surgeon_id TEXT, department TEXT, shift TEXT, skill TEXT);
\copy t_roster FROM 'data/v2_roster.csv' WITH (FORMAT csv, HEADER true)

CREATE TEMP TABLE t_solve (surgery_date DATE, solve_s NUMERIC);
\copy t_solve FROM 'data/v2_solve_seconds.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO department (name) SELECT DISTINCT department FROM t_sim ORDER BY 1;
INSERT INTO room (id) SELECT DISTINCT room FROM t_sim ORDER BY 1;

INSERT INTO sheet (name, source_file, is_active, note)
VALUES ('V2 example: 10 days, 241 surgeries', 'booking_sheet_example.csv', true,
        'Synthetic data from sorrs_cases_v2.csv. Simulated reality from V2 Step 1 (seed 1).');

INSERT INTO sheet_surgeon (sheet_id, surgeon_id, department_id, shift, skill)
SELECT 1, r.surgeon_id, d.id, r.shift, r.skill FROM t_roster r JOIN department d ON d.name = r.department;

INSERT INTO sheet_case (sheet_id, case_id, row_no, surgery_date, department_id, surgeon_id, room_id, booked_start_min,
                        booked_duration_min, is_emergency, booking_date, skill_required, actual_duration_min,
                        turnover_min, waiting_days, manual_actual_start_min)
SELECT 1, s.case_id, s.row_no, s.surgery_date, d.id, s.surgeon_id, s.room, s.booked_start_min, s.booked_duration_min,
       s.is_emergency = 1, s.booking_date, s.skill_required, s.actual_duration_min, s.turnover_min, s.waiting_days,
       s.actual_start_min::int
  FROM t_sim s JOIN department d ON d.name = s.department;

INSERT INTO plan_version (sheet_id, kind, mode, status, solve_s, note, published_at)
SELECT 1, 'v2_baseline', 'v2', 'published', jsonb_object_agg(to_char(surgery_date, 'YYYY-MM-DD'), solve_s),
       'V2 plan as delivered in the V2 pack (sorrs_optimized.csv)', clock_timestamp()
  FROM t_solve;

INSERT INTO plan_item (version_id, sheet_id, case_id, surgery_date, status, room_id, surgeon_id, planned_start_min,
                       planned_duration_min, turnover_min, actual_start_min)
SELECT 1, 1, o.case_id, o.surgery_date,
       CASE o.status WHEN 'scheduled' THEN 'scheduled' WHEN 'emergency (kept)' THEN 'emergency' ELSE 'deferred' END::item_status,
       NULLIF(o.room, ''), NULLIF(o.surgeon_id, ''), o.planned_start_min::int, o.planned_duration_min::int, o.turnover_min,
       CASE WHEN o.status <> 'deferred to next day' THEN o.actual_start_min::int END
  FROM t_opt o;

INSERT INTO audit_log (username, action, entity, entity_id, detail)
VALUES ('system', 'Data loaded', 'sheet', '1',
        (SELECT format('V2 data: %s cases, %s days, %s rooms, %s surgeons; V2 plan published as version 1',
                count(*), count(DISTINCT surgery_date), (SELECT count(*) FROM room), (SELECT count(*) FROM sheet_surgeon))
           FROM sheet_case));

DO $$
DECLARE n INT; e INT; c INT;
BEGIN
    SELECT count(*) INTO n FROM orbit.sheet_case;
    SELECT count(*) INTO e FROM orbit.plan_item;
    SELECT count(*) INTO c FROM orbit.v_spec_c1;
    IF n <> 241 OR e <> 241 THEN RAISE EXCEPTION 'expected 241 cases and 241 plan items, got % and %', n, e; END IF;
    IF c <> 0 THEN RAISE EXCEPTION 'C1 check failed'; END IF;
    RAISE NOTICE 'ORbit loaded: 241 cases on 10 days, V2 plan published with 0 room/surgeon clashes (enforced)';
END $$;
