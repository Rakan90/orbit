// GET /api/orbit/data -> the data object the ORbit page runs on.
//   Not signed in: the public showcase (the V2 sheet, as published), for the landing page.
//   Signed in:     the active sheet with the plans in force; ?version= shows a proposed plan.
import { Router } from 'express';
import { query } from '../db.js';
import { HttpError } from '../errors.js';
import { activeSheetId, buildD } from '../orbit.js';
import { callEngine } from '../engine.js';

const r = Router();

r.get('/data', async (req, res) => {
  let sheetId, version = null;
  if (!req.user) {
    const { rows } = await query(`SELECT id FROM sheet ORDER BY id LIMIT 1`);
    sheetId = rows[0]?.id;
  } else {
    sheetId = req.query.sheet ? Number(req.query.sheet) : await activeSheetId();
    if (req.query.version) {
      version = Number(req.query.version);
      const { rows } = await query('SELECT sheet_id FROM plan_version WHERE id = $1', [version]);
      if (!rows[0]) throw new HttpError(404, 'No such plan.');
      sheetId = rows[0].sheet_id;
    }
  }
  if (!sheetId) throw new HttpError(404, 'No booking sheet loaded yet. Run npm run db:reset.');
  const D = await buildD(sheetId, { overrideVersion: version });
  if (!D) throw new HttpError(404, 'No such sheet.');
  D.meta.signedIn = Boolean(req.user);
  res.set('cache-control', 'no-store').json(D);
});

// GET /api/orbit/model -> Specification 2: the ICS duration model's held-out evaluation (from the engine)
r.get('/model', async (req, res) => {
  try { res.json({ ok: true, ...(await callEngine('/model', null, 5)) }); } catch (err) { res.json({ ok: false, error: err.message }); }
});

// GET /api/orbit/engine -> is the planning engine up, and with which settings
r.get('/engine', async (req, res) => {
  try { res.json(await callEngine('/health', null, 5)); } catch (err) { res.json({ ok: false, error: err.message }); }
});

export default r;
