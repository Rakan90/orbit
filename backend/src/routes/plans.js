// Whole-sheet plans (V2 Step 2). ORbit proposes; the coordinator publishes.
//   GET  /api/plans?sheet=          versions of a sheet
//   POST /api/plans {sheetId?, mode} run the optimizer -> proposed plan (the database refuses any clash)
//   POST /api/plans/:id/publish      publish (supersedes the sheet's old plan and its repairs; makes the sheet active)
//   POST /api/plans/:id/reject       discard a proposed plan
import { Router } from 'express';
import { query, tx } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../errors.js';
import { requirePermission } from '../auth.js';
import { callEngine, planMode } from '../engine.js';
import { activeSheetId, buildD } from '../orbit.js';

const r = Router();
const fmtHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export async function engineRows(db, sheetId, { date = null } = {}) {
  const { rows } = await db.query(
    `SELECT c.*, d.name AS department FROM sheet_case c JOIN department d ON d.id = c.department_id
      WHERE c.sheet_id = $1 AND ($2::date IS NULL OR c.surgery_date = $2) ORDER BY c.row_no`, [sheetId, date]);
  return rows.map((c) => ({
    case_id: c.case_id, surgery_date: c.surgery_date, department: c.department, surgeon_id: c.surgeon_id, room: c.room_id,
    booked_start: c.booked_start_min == null ? null : fmtHHMM(c.booked_start_min), booked_duration_min: c.booked_duration_min,
    is_emergency: c.is_emergency ? 1 : 0, booking_date: c.booking_date, skill_required: c.skill_required,
    booked_start_min: c.booked_start_min, actual_duration_min: c.actual_duration_min, turnover_min: c.turnover_min,
    waiting_days: c.waiting_days, actual_start_min: c.manual_actual_start_min, added: c.added_by_emergency,
    ...(c.predicted_duration_min != null ? { complexity: c.complexity, asa_class: c.asa_class, bmi_band: c.bmi_band, age_band: c.age_band,
      anaesthesia: c.anaesthesia, predicted_duration_min: c.predicted_duration_min } : {}),
  }));
}

export async function rosterRows(db, sheetId) {
  const { rows } = await db.query(
    `SELECT s.surgeon_id, d.name AS department, s.shift, s.skill FROM sheet_surgeon s JOIN department d ON d.id = s.department_id
      WHERE s.sheet_id = $1 ORDER BY s.surgeon_id`, [sheetId]);
  return rows;
}

export async function insertItems(c, versionId, sheetId, items, turnover) {
  const col = (k) => items.map((i) => i[k] ?? null);
  await c.query(
    `INSERT INTO plan_item (version_id, sheet_id, case_id, surgery_date, status, room_id, surgeon_id, planned_start_min,
                            planned_duration_min, turnover_min, actual_start_min)
     SELECT $1, $2, x.id, x.d, x.st::item_status, x.r, x.s, x.ps, x.pd, x.t, x.a
       FROM unnest($3::text[], $4::date[], $5::text[], $6::text[], $7::text[], $8::int[], $9::int[], $10::int[], $11::int[])
            AS x(id, d, st, r, s, ps, pd, t, a)`,
    [versionId, sheetId, col('case_id'), col('surgery_date'), col('status'), col('room'), col('surgeon_id'),
      items.map((i) => (i.planned_start_min == null ? null : Math.round(i.planned_start_min))),
      items.map((i) => (i.planned_duration_min == null ? null : Math.round(i.planned_duration_min))),
      items.map((i) => turnover.get(i.case_id) ?? i.turnover_min),
      items.map((i) => (i.actual_start_min == null ? null : Math.round(i.actual_start_min)))]);
}

const summary = (D) => ({ T: D.T, K: D.K, meta: D.meta });

r.get('/', requirePermission('view'), async (req, res) => {
  const sheetId = req.query.sheet ? Number(req.query.sheet) : await activeSheetId();
  const { rows } = await query(
    `SELECT v.id, v.kind, v.mode, v.status, v.surgery_date AS "surgeryDate", v.solve_s AS "solveS", v.note,
            v.created_at AS "createdAt", u.username AS "createdBy", v.published_at AS "publishedAt", p.username AS "publishedBy"
       FROM plan_version v LEFT JOIN app_user u ON u.id = v.created_by LEFT JOIN app_user p ON p.id = v.published_by
      WHERE v.sheet_id = $1 ORDER BY v.id DESC`, [sheetId]);
  res.json(rows);
});

r.post('/', requirePermission('plan'), async (req, res) => {
  const sheetId = req.body?.sheetId ? Number(req.body.sheetId) : await activeSheetId();
  const mode = planMode(req.body?.mode);
  const rows = (await engineRows({ query }, sheetId)).filter((x) => !x.added);
  if (!rows.length) throw new HttpError(404, 'That sheet has no cases.');
  const roster = await rosterRows({ query }, sheetId);
  const startedAt = new Date();
  const out = await callEngine('/optimize', { rows, roster, mode });
  const turnover = new Map(rows.map((x) => [x.case_id, x.turnover_min]));
  const vid = await tx(async (c) => {
    const { rows: [v] } = await c.query(
      `INSERT INTO plan_version (sheet_id, kind, mode, status, solve_s, note, created_by)
       VALUES ($1, 'optimized', $2, 'proposed', $3, $4, $5) RETURNING id`,
      [sheetId, mode, JSON.stringify(out.solveS), `Optimizer run (${{ v2: 'V2 notebook durations', booked: 'booked durations', predicted: 'predicted durations, ICS model' }[mode]})`, req.user.id]);
    await insertItems(c, v.id, sheetId, out.items, turnover);
    await c.query(
      `INSERT INTO engine_run (kind, sheet_id, mode, started_at, finished_at, version_id, status, result, created_by)
       VALUES ('optimize', $1, $2, $3, clock_timestamp(), $4, 'succeeded', $5, $6)`,
      [sheetId, mode, startedAt, v.id, JSON.stringify({ solveS: out.solveS, totalS: out.totalS, clashes: out.clashes }), req.user.id]);
    await audit(c, req.user, 'Optimizer run', { entity: 'plan_version', entityId: v.id,
      detail: `${rows.length} cases, mode ${mode}, slowest day ${Math.max(...Object.values(out.solveS)).toFixed(1)} s, clashes ${out.clashes.join(' / ')}` });
    return v.id;
  });
  const D = await buildD(sheetId, { overrideVersion: vid });
  res.status(201).json({ id: vid, sheetId, mode, status: 'proposed', solveS: out.solveS, ...summary(D) });
});

r.post('/:id/publish', requirePermission('publish'), async (req, res) => {
  const id = Number(req.params.id);
  const v = await tx(async (c) => {
    const { rows: [v] } = await c.query('SELECT * FROM plan_version WHERE id = $1 FOR UPDATE', [id]);
    if (!v) throw new HttpError(404, 'No such plan.');
    if (v.kind === 'repair') throw new HttpError(400, 'Publish an emergency re-plan from the emergency.');
    if (v.status !== 'proposed') throw new HttpError(409, `Only a proposed plan can be published (this one is ${v.status}).`);
    const { rows: old } = await c.query(
      `UPDATE plan_version SET status = 'superseded' WHERE sheet_id = $1 AND status = 'published' RETURNING id, kind`, [v.sheet_id]);
    await c.query(`UPDATE plan_version SET status = 'published', published_by = $2, published_at = clock_timestamp() WHERE id = $1`, [id, req.user.id]);
    await c.query('UPDATE sheet SET is_active = false WHERE is_active AND id <> $1', [v.sheet_id]);
    await c.query('UPDATE sheet SET is_active = true WHERE id = $1', [v.sheet_id]);
    await audit(c, req.user, 'Plan published', { entity: 'plan_version', entityId: id,
      detail: `Sheet ${v.sheet_id} now runs on plan ${id} (${v.mode}); superseded ${old.map((o) => `${o.kind} ${o.id}`).join(', ') || 'nothing'}` });
    return v;
  });
  res.json({ id, status: 'published', sheetId: v.sheet_id });
});

r.post('/:id/reject', requirePermission('publish'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`UPDATE plan_version SET status = 'rejected' WHERE id = $1 AND status = 'proposed' AND kind <> 'repair' RETURNING id`, [id]);
  if (!rows[0]) throw new HttpError(409, 'Only a proposed plan can be discarded.');
  await audit({ query }, req.user, 'Plan discarded', { entity: 'plan_version', entityId: id });
  res.json({ id, status: 'rejected' });
});

export default r;
