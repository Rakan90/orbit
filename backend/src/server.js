import { createApp } from './app.js';
import { pool } from './db.js';
import { callEngine } from './engine.js';

const port = Number(process.env.PORT || 5055);

try {
  const { rows: [r] } = await pool.query('SELECT (SELECT count(*) FROM sheet_case)::int AS cases, (SELECT count(*) FROM app_user)::int AS users');
  console.log(`Database: ${r.cases} cases, ${r.users} accounts`);
  if (!r.users) console.log('No accounts yet: run npm run seed:users');
} catch (err) {
  console.error(`Cannot use the database (${err.message}). Run npm run db:reset first.`);
  process.exit(1);
}
try {
  const h = await callEngine('/health', null, 3);
  console.log(`Planning engine: ${h.engine}, ${h.solver}`);
} catch {
  console.log('Planning engine not running yet: start it with npm run engine (needed for re-plans, imports and optimizer runs)');
}

createApp().listen(port, () => console.log(`ORbit on http://localhost:${port}  (API under /api)`));
