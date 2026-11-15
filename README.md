# ORbit (SORRS V2) — Team M042

The ORbit website from V2, now backed by a real server: same screens, same V2 data, with sign-in,
a PostgreSQL database and Salem's V2 engine (`sorrs_tool_v2.py`) doing the planning.

```
orbit/
  backend/    Express API + the ORbit website (public/index.html, V2's page wired to the API)
  database/   schema.sql (constraints C1, C3, C4 enforced by PostgreSQL), load.sql, V2 data files
  engine/     Salem's V2 engine + service.py (HTTP on 127.0.0.1:5080, called only by the backend)
```

## What you need (Mac)

- Node.js 20.12 or newer
- PostgreSQL 14 or newer (Postgres.app is fine; its `bin` folder must be on your PATH)
- Python 3.10 or newer

## First run

```bash
cd orbit/backend
npm install
cp .env.example .env              # then put a long random string in JWT_SECRET
npm run db:reset                  # creates database "orbit": schema + V2 data + demo accounts
npm run engine:setup              # Python venv for the engine (numpy, pandas, scipy)
```

## Every time

Terminal 1 (engine):
```bash
cd orbit/backend && npm run engine
```
Terminal 2 (website + API):
```bash
cd orbit/backend && npm run dev
```
Open http://localhost:5055

## Tests

```bash
cd orbit/backend
npm run test:db                   # fresh test database "orbit_test"
npm test                          # 13 API tests (starts its own engine on port 5081)
npm run engine:test               # 4 engine tests
```

## Demo accounts (development only)

| Username       | Password        | Role                                     |
|----------------|-----------------|------------------------------------------|
| coordinator    | coordinator123  | OR coordinator: emergencies, plans, import, publish |
| admin          | admin123        | Administrator                            |
| viewer         | viewer123       | Read only                                |
| staff.sur001   | staff123        | OR staff, surgeon SUR001 (My schedule)   |
| staff.sur004   | staff123        | OR staff, surgeon SUR004                 |

Change these (`scripts/seed-users.js`) and `JWT_SECRET` before anyone else can reach the server.
Never commit `.env`.

## What is where in the website

- **Without signing in** the site shows V2's data exactly as the V2 page did.
- **Schedule → Emergency** (coordinator): the server re-plans the day with Salem's engine, times it
  (Specification 3), and shows Publish / Discard. The backend terminal prints an `[S3]` line.
- **Sign in as staff.sur001 → OR staff**: the first view of a published re-plan stops the end-to-end
  clock (Integrated Specification 2). The backend terminal prints an `[IS2]` line.
- **Emergencies**: the server record (registered, engine ms, published, seen by staff, end to end).
- **Integration → Choose a CSV file**: import a booking sheet → Plan it with ORbit → Publish.
- **Model settings → Plan with ORbit**: re-run the optimizer on the sheet in use, with booked
  durations (realistic) or V2 notebook durations (reproduces V2's results).
- **Prototype check → Run**: every number recomputed from the plans in the database.
- **Audit log**: every action with user and server time; the database refuses edits and deletes.

## Two planning modes

V2's results were measured with planned durations drawn around the simulated actual durations,
information a hospital does not have before surgery. `v2` mode reproduces those results exactly;
`booked` mode plans from booked durations only and is the honest estimate. The V2 plan itself is
loaded as plan 1, so the site starts with exactly V2's numbers.

## One fix to Salem's engine

`replan` let a second emergency on the same day land in the room of a first emergency placed later
that day (the database refused the clash). Two lines in `sorrs_tool_v2.py`, marked `ORbit fix`.

## Put it on GitHub

Create an empty repository on GitHub (no README, no .gitignore), then:

```bash
cd orbit
git init -b main
git add .
git commit -m "ORbit: V2 website with backend, database and Salem's V2 engine"
git remote add origin https://github.com/<your-account>/orbit.git
git push -u origin main
```

`.gitignore` already keeps out `node_modules/`, `.env` and the engine's `.venv/`.
