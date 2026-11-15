// Client for Salem's V2 engine service (../engine/service.py).
import { HttpError } from './errors.js';

export const engineUrl = () => (process.env.ENGINE_URL || 'http://127.0.0.1:5080').replace(/\/$/, '');

export async function callEngine(path, body, timeoutS = 600) {
  let res;
  try {
    res = await fetch(engineUrl() + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
  } catch (err) {
    throw new HttpError(503, `The planning engine is not running at ${engineUrl()}. Start it with: npm run engine`, { cause: err.name });
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Planning engine: ${out.error || res.status}`);
  return out;
}

export const planMode = (m) => {
  const mode = m || process.env.DEFAULT_PLAN_MODE || 'booked';
  if (!['booked', 'v2', 'predicted'].includes(mode)) throw new HttpError(400, 'mode must be "booked", "v2" or "predicted"');
  return mode;
};
