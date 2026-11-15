import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { query } from './db.js';
import { identify } from './auth.js';
import { errorHandler, HttpError } from './errors.js';
import authRoutes from './routes/auth.js';
import dataRoutes from './routes/data.js';
import sheetRoutes from './routes/sheets.js';
import planRoutes from './routes/plans.js';
import emergencyRoutes from './routes/emergencies.js';
import staffRoutes from './routes/staff.js';
import auditRoutes from './routes/audit.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', identify);

  app.get('/api/health', async (req, res) => {
    const { rows: [r] } = await query(
      `SELECT (SELECT count(*) FROM sheet_case)::int AS cases, (SELECT count(*) FROM sheet)::int AS sheets,
              (SELECT id FROM sheet WHERE is_active) AS "activeSheet"`);
    res.json({ ok: true, ...r });
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/orbit', dataRoutes);
  app.use('/api/sheets', sheetRoutes);
  app.use('/api/plans', planRoutes);
  app.use('/api/emergencies', emergencyRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api', (req, res, next) => next(new HttpError(404, `No endpoint ${req.method} ${req.originalUrl || req.url}`)));

  app.use(express.static(path.join(here, '..', 'public')));    // the ORbit website
  app.use(errorHandler);
  return app;
}
