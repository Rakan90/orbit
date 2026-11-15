// GET /api/staff/schedule?date=&surgeon=  one surgeon's published day.
// An OR staff account sees only its own day; its first view after an emergency was published
// stops the Integrated Specification 2 clock (end_to_end_ms is computed by PostgreSQL).
import { Router } from 'express';
import { query, tx } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../errors.js';
import { requirePermission } from '../auth.js';
import { activeSheetId } from '../orbit.js';

const r = Router();

r.get('/schedule', requirePermission('view'), async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const isStaff = req.user.role === 'staff';
  const surgeon = isStaff ? req.user.surgeonId : String(req.query.surgeon || '');
  if (!surgeon) throw new HttpError(400, 'surgeon is required');
  const sheetId = await activeSheetId();
  const { rows: [{ v }] } = await query('SELECT version_in_force($1, $2::date) AS v', [sheetId, date]);
  const { rows: items } = await query(
    `SELECT i.case_id AS "caseId", i.room_id AS room, i.planned_start_min AS "startMin", i.planned_duration_min AS "durMin",
            i.status, d.name AS department, c.is_emergency AS "isEmergency"
       FROM plan_item i JOIN sheet_case c ON c.sheet_id = i.sheet_id AND c.case_id = i.case_id
       JOIN department d ON d.id = c.department_id
      WHERE i.version_id = $1 AND i.surgery_date = $2::date AND i.surgeon_id = $3 AND i.status <> 'deferred'
      ORDER BY i.planned_start_min`, [v, date, surgeon]);
  let seen = [];
  if (isStaff) {
    seen = await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE emergency_event SET first_seen_at = clock_timestamp(), first_seen_by = $3
          WHERE sheet_id = $1 AND surgery_date = $2::date AND published_at IS NOT NULL AND first_seen_at IS NULL
            AND version_id = version_in_force($1, $2::date)
          RETURNING id, case_id AS "caseId", end_to_end_ms AS "endToEndMs"`, [sheetId, date, req.user.id]);
      for (const e of rows) {
        await audit(c, req.user, 'Published re-plan first seen by OR staff', { entity: 'emergency', entityId: e.id,
          detail: `${e.caseId}: end to end ${(e.endToEndMs / 1000).toFixed(1)} s (limit 600 s)` });
      }
      return rows;
    });
    for (const e of seen) {
      console.log(`[IS2] emergency ${e.id} (${e.caseId}): registered -> seen by ${req.user.username} in ${(e.endToEndMs / 1000).toFixed(1)} s `
        + `(limit 600 s) ${e.endToEndMs <= 600000 ? 'MET' : 'NOT MET'}`);
    }
  }
  res.set('cache-control', 'no-store').json({ date, surgeon, versionId: v, items, seen });
});

export default r;
