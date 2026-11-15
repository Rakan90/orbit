"""
ORbit engine service: Salem's V2 engine (sorrs_tool_v2.py) behind HTTP.
Only the backend calls it. Listens on 127.0.0.1 (ENGINE_PORT, default 5080).

  GET  /health                          engine constants, solver
  POST /simulate  {rows}                -> booking sheet + simulated reality (V2 Step 1)
  POST /optimize  {rows, roster, mode}  -> plan for every day (V2 Step 2)
  POST /replan    {rows, roster, date, nowMin, newCase, mode}
                                        -> re-planned day after an emergency (V2 Step 3)

mode:
  "v2"      exactly as the notebook: planned durations are drawn around the simulated
            actual durations (what the V2 results were measured with)
  "booked"  the planner sees only the booked durations, as a real hospital would

sorrs_tool_v2.py has one fix (replan: an emergency already placed later in the day now
blocks its room, so a second emergency on the same day cannot land on top of it).
"booked" only hands solve_day a copy of the cases
in which the actual duration is replaced by the booked one, with the noise switched off.
"""
import json
import os
import threading
import sys
import time
import traceback
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pandas as pd
import scipy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sorrs_tool_v2 as v2  # noqa: E402  Salem's engine (one fix in replan, marked ORbit fix)

MODES = ("v2", "booked")
_LOCK = threading.Lock()      # the planning mode switches a module global: one solve at a time
_orig_solve_day = v2.solve_day


def _solve_day_booked(el, *a, **k):
    el = el.copy()
    el["actual_duration_min"] = el["booked_duration_min"]
    keep = v2.PRED_CV
    v2.PRED_CV = 0.0
    try:
        return _orig_solve_day(el, *a, **k)
    finally:
        v2.PRED_CV = keep


@contextmanager
def planning_mode(mode):
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    v2.solve_day = _solve_day_booked if mode == "booked" else _orig_solve_day
    try:
        yield
    finally:
        v2.solve_day = _orig_solve_day


def _df(rows):
    return pd.DataFrame(rows)


def _roster(rows):
    r = pd.DataFrame(rows)
    return r.set_index("surgeon_id")[["department", "shift", "skill"]]


def _clean(df, cols):
    out = []
    for rec in df[cols].to_dict("records"):
        o = {}
        for k, v in rec.items():
            if isinstance(v, (np.integer,)):
                v = int(v)
            elif isinstance(v, (np.floating, float)):
                v = None if (v != v) else (int(v) if float(v).is_integer() else float(v))
            elif v is None or (isinstance(v, str) and v == ""):
                v = None
            o[k] = v
        out.append(o)
    return out


PLAN_COLS = ["case_id", "surgery_date", "room", "surgeon_id", "planned_start_min", "planned_duration_min",
             "actual_start_min", "status"]


def simulate(body):
    book = _df(body["rows"])
    for col in ("is_emergency",):
        if col in book:
            book[col] = book[col].fillna(0).astype(int)
    sim = v2.simulate(book, seed=int(body.get("seed", 1)))
    roster = v2.roster_from(sim).reset_index()
    cols = ["case_id", "surgery_date", "department", "surgeon_id", "room", "booked_start", "booked_duration_min",
            "is_emergency", "booking_date", "skill_required", "booked_start_min", "actual_duration_min",
            "turnover_min", "waiting_days", "actual_start_min"]
    return {"rows": _clean(sim, cols),
            "roster": _clean(roster.rename(columns={"index": "surgeon_id"}), ["surgeon_id", "department", "shift", "skill"])}


def optimize(body):
    sim = _df(body["rows"])
    sim["is_emergency"] = sim["is_emergency"].astype(int)
    roster = _roster(body["roster"]) if body.get("roster") else None
    with planning_mode(body.get("mode", "booked")):
        t0 = time.perf_counter()
        opt, log = v2.optimize(sim, roster, seed=int(body.get("seed", 1)))
        total = time.perf_counter() - t0
    days = sorted(sim.surgery_date.unique())
    status = {"scheduled": "scheduled", "emergency (kept)": "emergency", "deferred to next day": "deferred"}
    opt["status"] = opt["status"].map(status)
    sched = opt[opt.status != "deferred"]
    clash = v2.overlaps(sched)
    return {"items": _clean(opt, PLAN_COLS),
            "solveS": {d: round(float(s), 3) for d, s in zip(days, log)},
            "totalS": round(total, 3), "clashes": list(clash)}


def replan(body):
    day = body["date"]
    rows = _df(body["rows"])                      # the day's plan in force (scheduled + emergencies + deferred)
    rows["is_emergency"] = rows["is_emergency"].astype(int)
    back = {"scheduled": "scheduled", "emergency": "emergency (kept)", "deferred": "deferred to next day"}
    rows["status"] = rows["status"].map(back)
    roster = _roster(body["roster"]) if body.get("roster") else None
    nc = dict(body["newCase"])                    # case_id, department, surgeon_id, booked_duration_min, is_emergency
    nc.setdefault("is_emergency", 1)
    now = v2.min_to_hhmm(int(body["nowMin"]))
    before = rows.set_index("case_id")
    with planning_mode(body.get("mode", "booked")):
        t0 = time.perf_counter()
        out = v2.replan(rows, day, now, nc, roster, seed=int(body.get("seed", 7)))
        solve = time.perf_counter() - t0
    out = out[out.surgery_date == day].reset_index(drop=True).copy()
    status = {"scheduled": "scheduled", "emergency (kept)": "emergency", "emergency (added)": "emergency",
              "deferred to next day": "deferred"}
    out["status"] = out["status"].map(status)
    sched = out[out.status != "deferred"].reset_index(drop=True).copy()
    sched = v2.replay(sched, "planned_start_min")  # what happens with the simulated durations
    out = pd.concat([sched, out[out.status == "deferred"]], ignore_index=True)
    new = out[out.case_id == nc["case_id"]].iloc[0]
    moved = int(sum(1 for r in sched.itertuples() if r.case_id in before.index
                    and before.loc[r.case_id, "planned_start_min"] == before.loc[r.case_id, "planned_start_min"]
                    and float(before.loc[r.case_id, "planned_start_min"]) != float(r.planned_start_min)))
    clash = v2.overlaps(sched)
    cols = PLAN_COLS + ["actual_duration_min", "turnover_min"]
    return {"items": _clean(out, cols), "solveS": round(solve, 3), "clashes": list(clash), "moved": moved,
            "emergency": {"case_id": nc["case_id"], "room": new.room, "start_min": int(new.planned_start_min),
                          "actual_duration_min": int(new.actual_duration_min), "turnover_min": int(new.turnover_min)}}


def health():
    return {"ok": True, "engine": "sorrs_tool_v2 (Team M042, ISE)", "solver": f"HiGHS via SciPy {scipy.__version__}",
            "modes": list(MODES),
            "constants": {"roomDayMin": v2.CAP, "dayStartMin": v2.DAY0, "plannedOvertimeMin": v2.OMAX,
                          "safetyBuffer": v2.BETA, "shiftTolerance": v2.DELTA, "wWait": v2.W_WAIT, "wOvertime": v2.W_OT,
                          "wRoomBalance": v2.W_BAL, "wShift": v2.W_S1, "timeLimitS": v2.TIME_LIMIT,
                          "overtimeSarPerMin": v2.TEAM_RATE_SAR_MIN}}


ROUTES = {"/simulate": simulate, "/optimize": optimize, "/replan": replan}


class Handler(BaseHTTPRequestHandler):
    server_version = "orbit-engine/1.0"

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, health())
        self._send(404, {"error": f"No endpoint GET {self.path}"})

    def do_POST(self):
        fn = ROUTES.get(self.path)
        if not fn:
            return self._send(404, {"error": f"No endpoint POST {self.path}"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 20_000_000:
                return self._send(400, {"error": "Body missing or too large"})
            body = json.loads(self.rfile.read(n))
            with _LOCK:
                out = fn(body)
        except (KeyError, ValueError, TypeError) as e:
            traceback.print_exc()
            return self._send(400, {"error": f"Bad input: {e}"})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._send(500, {"error": f"Engine failed: {e}"})
        self._send(200, out)

    def log_message(self, fmt, *args):
        sys.stderr.write("engine: " + fmt % args + "\n")


if __name__ == "__main__":
    port = int(os.environ.get("ENGINE_PORT", "5080"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"ORbit engine (Salem's V2) on http://127.0.0.1:{port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
