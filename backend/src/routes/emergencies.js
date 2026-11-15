// Emergencies (V2 Step 3, Spec 3 and Integrated Spec 2), timed by the server.
//   POST /api/emergencies {date, nowMin, department, surgeonId, minutes}
//        registered -> Salem's re-plan on the engine -> proposed repair plan stored (S3 clock stops)
//   POST /api/emergencies/:id/publish   the coordinator publishes it to OR staff
//   POST /api/emergencies/:id/discard   or discards it
//   GET  /api/emergencies?date=         with every timestamp
// The IS2 clock stops when an OR staff account first opens its schedule (routes/staff.js).
import { Router } from 'express';
import { query, tx } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../errors.js';
import { requirePermission } from '../auth.js';
import { callEngine, planMode } from '../engine.js';
import { activeSheetId } from '../orbit.js';
import { engineRows, insertItems, rosterRows } from './plans.js';

const r = Router();
const local = (t) => `${t.toLocaleString('sv-SE')}.${String(t.getMilliseconds()).padStart(3, '0')}`;

const EVENT = `SELECT e.id, e.sheet_id AS "sheetId", e.surgery_date AS date, e.case_id AS "caseId", e.now_min AS "nowMin",
                      d.name AS department, e.surgeon_id AS "surgeonId", e.expected_min AS minutes, e.version_id AS "versionId",
                      v.status AS "versionStatus", e.registered_at AS "registeredAt", e.engine_finished_at AS "engineFinishedAt",
                      e.engine_ms AS "engineMs", e.published_at AS "publishedAt", e.first_seen_at AS "firstSeenAt",
                      e.end_to_end_ms AS "endToEndMs", e.result, u.username AS "registeredBy"
                 FROM emergency_event e JOIN department d ON d.id = e.department_id
                 LEFT JOIN plan_version v ON v.id = e.version_id LEFT JOIN app_user u ON u.id = e.registered_by`;

r.get('/', requirePermission('view'), async (req, res) => {
  const sheetId = await activeSheetId();
  const { rows } = await query(`${EVENT} WHERE e.sheet_id = $1 AND ($2::date IS NULL OR e.surgery_date = $2) ORDER BY e.id DESC LIMIT 200`,
    [sheetId, req.query.date || null]);
  res.json(rows);
});

r.post('/', requirePermission('emergency'), async (req, res) => {
  const registeredAt = new Date();                       // the server receives the emergency
  const b = req.body || {};
  const sheetId = await activeSheetId();
  const date = String(b.date || '');
  const nowMin = Number(b.nowMin), minutes = Number(b.minutes);
  if (!Number.isInteger(nowMin) || nowMin < 0 || nowMin > 1439) throw new HttpError(400, 'nowMin must be minutes after midnight.');
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 400) throw new HttpError(400, 'Enter expected minutes between 15 and 400.');
  const { rows: [day] } = await query('SELECT count(*)::int AS n FROM sheet_case WHERE sheet_id = $1 AND surgery_date = $2::date', [sheetId, /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null]);
  if (!day?.n) throw new HttpError(400, 'That day is not on the active booking sheet.');
  const { rows: [sur] } = await query(
    `SELECT s.surgeon_id, d.id AS department_id, d.name AS department FROM sheet_surgeon s JOIN department d ON d.id = s.department_id
      WHERE s.sheet_id = $1 AND s.surgeon_id = $2`, [sheetId, String(b.surgeonId || '')]);
  if (!sur) throw new HttpError(400, 'Pick a surgeon from the roster.');
  if (b.department && b.department !== sur.department) throw new HttpError(400, `${sur.surgeon_id} works in ${sur.department}, not ${b.department}.`);
  const mode = planMode(b.mode);

  // the day's plan in force, in the shape Salem's replan expects
  const { rows: [{ v: baseId }] } = await query('SELECT version_in_force($1, $2::date) AS v', [sheetId, date]);
  if (!baseId) throw new HttpError(409, 'Publish a plan for this sheet first.');
  const cases = new Map((await engineRows({ query }, sheetId, { date })).map((c) => [c.case_id, c]));
  const { rows: items } = await query('SELECT * FROM plan_item WHERE version_id = $1 AND surgery_date = $2::date', [baseId, date]);
  const rows = items.map((i) => ({ ...cases.get(i.case_id), room: i.room_id, surgeon_id: i.surgeon_id, status: i.status,
    planned_start_min: i.planned_start_min, planned_duration_min: i.planned_duration_min }));
  const before = new Map(items.map((i) => [i.case_id, i]));
  const { rows: [{ n: next }] } = await query(
    `SELECT COALESCE(max(substring(case_id from 2)::int), 0) + 1 AS n FROM sheet_case WHERE sheet_id = $1 AND case_id ~ '^E[0-9]+$'`, [sheetId]);
  const caseId = `E${String(next).padStart(5, '0')}`;
  const out = await callEngine('/replan', {
    date, nowMin, mode, rows, roster: await rosterRows({ query }, sheetId),
    newCase: { case_id: caseId, department: sur.department, surgeon_id: sur.surgeon_id, booked_duration_min: minutes, is_emergency: 1 },
  });

  const em = out.emergency;
  const deferred = out.items.filter((i) => i.status === 'deferred').map((i) => i.case_id);
  const result = { room: em.room, atMin: em.start_min, moved: out.moved, deferred, clashes: out.clashes, solveS: out.solveS, mode, baseVersion: baseId };
  const id = await tx(async (c) => {
    await c.query(
      `INSERT INTO sheet_case (sheet_id, case_id, row_no, surgery_date, department_id, surgeon_id, room_id, booked_start_min,
                               booked_duration_min, is_emergency, booking_date, skill_required, actual_duration_min, turnover_min,
                               waiting_days, added_by_emergency)
       VALUES ($1, $2, (SELECT max(row_no) + 1 FROM sheet_case WHERE sheet_id = $1), $3, $4, $5, NULL, $6, $7, true, $3, 'standard', $8, $9, 0, true)`,
      [sheetId, caseId, date, sur.department_id, sur.surgeon_id, nowMin, minutes, em.actual_duration_min, em.turnover_min]);
    // only one open re-plan per day: an earlier unpublished one is set aside
    await c.query(`UPDATE plan_version SET status = 'rejected' WHERE sheet_id = $1 AND kind = 'repair' AND surgery_date = $2 AND status = 'proposed'`, [sheetId, date]);
    const { rows: [v] } = await c.query(
      `INSERT INTO plan_version (sheet_id, kind, mode, status, surgery_date, parent_id, solve_s, note, created_by)
       VALUES ($1, 'repair', $2, 'proposed', $3, $4, $5, $6, $7) RETURNING id`,
      [sheetId, mode, date, baseId, JSON.stringify({ [date]: out.solveS }), `Emergency ${caseId}`, req.user.id]);
    const turnover = new Map(out.items.map((i) => [i.case_id, i.turnover_min]));
    await insertItems(c, v.id, sheetId, out.items, turnover);            // the database refuses any clash (C3)
    await c.query(
      `INSERT INTO engine_run (kind, sheet_id, mode, started_at, finished_at, version_id, status, result, created_by)
       VALUES ('replan', $1, $2, $3, clock_timestamp(), $4, 'succeeded', $5, $6)`,
      [sheetId, mode, registeredAt, v.id, JSON.stringify(result), req.user.id]);
    const { rows: [e] } = await c.query(
      `INSERT INTO emergency_event (sheet_id, surgery_date, case_id, now_min, department_id, surgeon_id, expected_min, registered_by,
                                    registered_at, version_id, result, engine_finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp()) RETURNING id`,
      [sheetId, date, caseId, nowMin, sur.department_id, sur.surgeon_id, minutes, req.user.id, registeredAt, v.id, JSON.stringify(result)]);
    await audit(c, req.user, 'Emergency registered and re-planned', { entity: 'emergency', entityId: e.id,
      detail: `${date} at ${Math.floor(nowMin / 60)}:${String(nowMin % 60).padStart(2, '0')}: ${sur.department}, ${sur.surgeon_id}, ${minutes} min -> ${em.room}; ${out.moved} re-timed, ${deferred.length} moved a day, clashes ${out.clashes.join(' / ')}` });
    return e.id;
  });
  // Spec 3 evidence, printed from the database after commit (engine_ms is computed by PostgreSQL)
  const { rows: [ev] } = await query(`${EVENT} WHERE e.id = $1`, [id]);
  console.log(`[S3] emergency ${id} (${caseId}): registered ${local(ev.registeredAt)}, re-plan stored ${local(ev.engineFinishedAt)} -> `
    + `${ev.engineMs} ms (limit 300000 ms) ${ev.engineMs <= 300000 ? 'MET' : 'NOT MET'}`);
  res.status(201).json({
    ...ev,
    items: out.items.map((i) => {
      const was = before.get(i.case_id);
      const mv = Boolean(was && was.status !== 'deferred' && i.status !== 'deferred' && was.planned_start_min !== Math.round(i.planned_start_min));
      return { caseId: i.case_id, status: i.status, room: i.room, surgeonId: i.surgeon_id, startMin: i.planned_start_min == null ? null : Math.round(i.planned_start_min),
        durMin: i.planned_duration_min == null ? null : Math.round(i.planned_duration_min), turnoverMin: i.turnover_min,
        actualMin: i.actual_duration_min, isNew: i.case_id === caseId, moved: mv, wasStartMin: was?.planned_start_min ?? null };
    }),
  });
});

r.post('/:id/publish', requirePermission('publish'), async (req, res) => {
  const id = Number(req.params.id);
  await tx(async (c) => {
    const { rows: [e] } = await c.query('SELECT * FROM emergency_event WHERE id = $1 FOR UPDATE', [id]);
    if (!e) throw new HttpError(404, 'No such emergency.');
    const { rows: [v] } = await c.query('SELECT * FROM plan_version WHERE id = $1 FOR UPDATE', [e.version_id]);
    if (!v || v.status !== 'proposed') throw new HttpError(409, `This re-plan is ${v ? v.status : 'gone'}; register the emergency again.`);
    await c.query(`UPDATE plan_version SET status = 'superseded' WHERE sheet_id = $1 AND kind = 'repair' AND surgery_date = $2 AND status = 'published'`,
      [v.sheet_id, v.surgery_date]);
    await c.query(`UPDATE plan_version SET status = 'published', published_by = $2, published_at = clock_timestamp() WHERE id = $1`, [v.id, req.user.id]);
    await c.query('UPDATE emergency_event SET published_at = clock_timestamp(), published_by = $2 WHERE id = $1', [id, req.user.id]);
    await audit(c, req.user, 'Emergency re-plan published', { entity: 'emergency', entityId: id,
      detail: `${e.case_id} on ${e.surgery_date}: plan ${v.id} is now in force and visible to OR staff` });
  });
  const { rows: [ev] } = await query(`${EVENT} WHERE e.id = $1`, [id]);
  res.json(ev);
});

r.post('/:id/discard', requirePermission('publish'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [e] } = await query('SELECT * FROM emergency_event WHERE id = $1', [id]);
  if (!e) throw new HttpError(404, 'No such emergency.');
  const { rows } = await query(`UPDATE plan_version SET status = 'rejected' WHERE id = $1 AND status = 'proposed' RETURNING id`, [e.version_id]);
  if (!rows[0]) throw new HttpError(409, 'Only an unpublished re-plan can be discarded.');
  await audit({ query }, req.user, 'Emergency re-plan discarded', { entity: 'emergency', entityId: id });
  res.json({ id, discarded: true });
});

export default r;
