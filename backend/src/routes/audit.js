import { Router } from 'express';
import { query } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../errors.js';
import { requirePermission } from '../auth.js';

const r = Router();
// actions that happen only in the browser and are still worth a line in the log
const CLIENT_ACTIONS = ['Guided tour started', 'Report copied as CSV', 'Prototype check run', 'Booking sheet previewed'];

r.get('/', requirePermission('view'), async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const { rows } = await query(
    `SELECT id, at, username, action, entity, entity_id AS "entityId", detail FROM audit_log ORDER BY id DESC LIMIT $1`, [limit]);
  res.set('cache-control', 'no-store').json(rows);
});

r.post('/events', requirePermission('view'), async (req, res) => {
  const action = String(req.body?.action || '');
  if (!CLIENT_ACTIONS.includes(action)) throw new HttpError(400, `Unknown action. Allowed: ${CLIENT_ACTIONS.join(', ')}`);
  await audit({ query }, req.user, action, { detail: req.body?.detail ? String(req.body.detail).slice(0, 300) : null });
  res.status(201).json({ ok: true });
});

export default r;
