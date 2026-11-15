// PostgreSQL pool. Dates come back as 'YYYY-MM-DD', counts and numerics as numbers,
// and every connection works in the `orbit` schema.
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v);          // date
pg.types.setTypeParser(20, (v) => Number(v));     // int8
pg.types.setTypeParser(1700, (v) => Number(v));   // numeric

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/orbit',
  max: 10,
  options: '-c search_path=orbit,public',
});

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
