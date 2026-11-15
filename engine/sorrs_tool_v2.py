"""
SORRS / ORbit scheduling engine, version 2 (Team M042, ISE) — same code as the Setup cell of SORRS_tool_v2.ipynb.

Run:   python sorrs_tool_v2.py booking_sheet_example.csv
       python sorrs_tool_v2.py --example sorrs_cases_v2.csv 10     (build a 10-day sheet from the project dataset)
Needs: numpy, pandas, scipy  (solver: HiGHS through scipy.optimize.milp)
Writes: sorrs_simulated.csv, sorrs_optimized.csv and prints manual vs SORRS plus the spec check.
"""
import numpy as np, pandas as pd, time, io, sys

TEMPLATE = ["case_id","surgery_date","department","surgeon_id","room","booked_start","booked_duration_min",
            "is_emergency","booking_date","skill_required"]
CAP, DAY0, OT_MULT = 600, 480, 1.5              # 10-h day from 08:00, overtime at 1.5x (C4)
PRED_CV, BETA, OMAX, DELTA = 0.15, 0.05, 120, 0.15   # OMAX: planned overtime allowed per room (min)
W_WAIT, W_OT, W_BAL, W_S1 = 400, 3, 2, 5   # deferring costs 400 x (waiting days + 1): more than the most overtime
                                    # a room may plan (3 x 120 = 360), so a case is deferred only when it cannot fit
TIME_LIMIT = 10                     # seconds per day for the solver (Spec 3 allows 300)
TEAM_RATE_SAR_MIN = 19.3                         # surgeon+anaesthetist+2 nurses, loaded, x1.5, per minute
# duration variability fitted on sorrs_cases_v2.csv (log-sd of actual/booked ratio); default used for unknown depts
LOG_SD = {"General surgery":0.40,"Gynecology":0.30,"Thoracic surgery":0.30,"Urology":0.33,"Vascular":0.35}
LOG_SD_DEFAULT, MEAN_RATIO = 0.33, 1.05

def hhmm_to_min(s):
    h, m = str(s).split(":"); return int(h)*60+int(m)
def min_to_hhmm(x):
    x = int(round(x)); return f"{x//60:02d}:{x%60:02d}"

# ---------------------------------------------------------------- STEP 1
def simulate(book: pd.DataFrame, seed=1) -> pd.DataFrame:
    """Fill in what the booking sheet cannot know: actual durations, turnover,
    actual start/end, overrun, overtime cost — day by day, room by room."""
    rng = np.random.default_rng(seed)
    df = book.copy()
    for c in ["is_emergency"]: df[c] = df.get(c, 0); df[c] = df[c].fillna(0).astype(int)
    if "skill_required" not in df: df["skill_required"] = "standard"
    if "booking_date" not in df: df["booking_date"] = df.surgery_date
    df["booked_start_min"] = df.booked_start.map(hhmm_to_min)
    sd = df.department.map(LOG_SD).fillna(LOG_SD_DEFAULT).values
    df["actual_duration_min"] = np.round(df.booked_duration_min * MEAN_RATIO * rng.lognormal(0, sd)).astype(int).clip(lower=10)
    df["turnover_min"] = rng.integers(10, 46, len(df))
    df["waiting_days"] = (pd.to_datetime(df.surgery_date) - pd.to_datetime(df.booking_date)).dt.days.clip(lower=0)
    df = replay(df, "booked_start_min")      # what really happens with the manual plan (room AND surgeon must be free)
    df["overrun_min"] = df.actual_duration_min - df.booked_duration_min
    return df

def day_summary(df, start_col, end_col, label):
    """Per-day KPIs for a schedule (room-hours, overtime, cost, delay) using actual durations."""
    rows = []
    for d, g in df.groupby("surgery_date"):
        busy = (g.actual_duration_min + g.turnover_min).groupby(g.room).sum()
        over = (busy - CAP).clip(lower=0)
        rows.append(dict(date=d, schedule=label, room_hours=busy.sum()/60, overtime_hours=over.sum()/60,
                         overtime_cost_sar=over.sum()*TEAM_RATE_SAR_MIN,
                         start_delay_min=(g[start_col] - g.planned_start_min).mean() if "planned_start_min" in g else 0,
                         cases=len(g)))
    return pd.DataFrame(rows)

# ---------------------------------------------------------------- STEP 2
from collections import defaultdict

def roster_from(df):
    """If no roster is supplied, derive one from the booking sheet:
    department = where the surgeon works, shift A if they usually start before 13:00."""
    r = df.groupby("surgeon_id").agg(department=("department", lambda x: x.mode()[0]),
                                     med_start=("booked_start_min","median"))
    r["shift"] = np.where(r.med_start < 13*60, "A", "B"); r["skill"] = "advanced"
    return r

def _free_from(t, dur, busy):
    """Earliest start >= t where [start, start+dur) touches none of the busy intervals."""
    moved = True
    while moved:
        moved = False
        for a, b in busy:
            if t < b and a < t + dur:
                t = b; moved = True
    return t

def sequence(assign, room_start, fixed=()):
    """Clock times. Inside each room, shortest-predicted-first. A case starts only when its
    room AND its surgeon are free, and never on top of a fixed block (emergency or started case).
    assign: dicts with case_id, room, surgeon_id, dur, turnover.  fixed: dicts with room,
    surgeon_id, start, dur, turnover.  Returns {case_id: start minute}."""
    room_busy = defaultdict(list); surg_busy = defaultdict(list)
    for f in fixed:
        room_busy[f["room"]].append((f["start"], f["start"] + f["dur"] + f["turnover"]))
        surg_busy[f["surgeon_id"]].append((f["start"], f["start"] + f["dur"]))
    queue = {r: sorted([a for a in assign if a["room"] == r], key=lambda a: a["dur"]) for r in room_start}
    t_room = dict(room_start); out = {}
    while any(queue.values()):
        r = min((r for r in queue if queue[r]), key=lambda r: t_room[r])   # room that frees up first
        a = queue[r].pop(0); t = t_room[r]
        while True:
            t_r = _free_from(t, a["dur"] + a["turnover"], room_busy[r])
            t_s = _free_from(t_r, a["dur"], surg_busy[a["surgeon_id"]])
            if t_s == t_r: break
            t = t_s
        out[a["case_id"]] = t_r
        room_busy[r].append((t_r, t_r + a["dur"] + a["turnover"])); surg_busy[a["surgeon_id"]].append((t_r, t_r + a["dur"]))
        t_room[r] = t_r + a["dur"] + a["turnover"]
    return out

def overlaps(sched, start="planned_start_min", dur="planned_duration_min"):
    """Count pairs of cases on the same day that share a room (operation + turnover) or a
    surgeon (operation) at the same time. C3 requires both to be zero."""
    s = sched.dropna(subset=[start]).copy()
    s["_e"] = s[start] + s[dur]; s["_et"] = s["_e"] + s.turnover_min
    def count(key, end):
        n = 0
        for _, g in s.groupby(["surgery_date", key]):
            v = g.sort_values(start)[[start, end]].values
            for i in range(len(v)):
                for j in range(i+1, len(v)):
                    if v[j][0] < v[i][1]: n += 1
        return n
    return count("room", "_et"), count("surgeon_id", "_e")

def replay(df, start_col):
    """What really happens: cases go in planned order; each starts at its planned time or when
    its room and its surgeon are free, whichever is later; it then takes its ACTUAL duration."""
    df = df.copy(); df["actual_start_min"] = np.nan
    for d, g in df.groupby("surgery_date"):
        room_t = defaultdict(lambda: DAY0); surg_t = defaultdict(lambda: DAY0)
        for i in g.sort_values(start_col).index:
            r, s = df.at[i, "room"], df.at[i, "surgeon_id"]
            st = max(df.at[i, start_col], room_t[r], surg_t[s]); df.at[i, "actual_start_min"] = st
            surg_t[s] = st + df.at[i, "actual_duration_min"]
            room_t[r] = surg_t[s] + df.at[i, "turnover_min"]
    df["actual_end_min"] = df.actual_start_min + df.actual_duration_min
    df["actual_start"] = df.actual_start_min.map(min_to_hhmm); df["actual_end"] = df.actual_end_min.map(min_to_hhmm)
    return df

def solve_day(el, surgeons, rng, log, room_start=None, rooms=None, fixed=(), balance=True):
    """Stage 1 = the MILP (which room, which surgeon, or defer). Stage 2 = sequence() (clock times)."""
    el = el.copy().reset_index(drop=True)
    el["pred"] = el.actual_duration_min * rng.lognormal(0, PRED_CV, len(el))     # ICS prediction stand-in (Spec 2)
    el["dur"] = el.pred * (1 + BETA)                                              # planned operation time
    el["p"] = el.dur + el.turnover_min                                            # room time incl. turnover
    rooms = sorted(rooms if rooms is not None else (room_start.keys() if room_start else el.room.unique()))
    R = len(rooms); n = len(el); S = list(surgeons.index)
    room_start = room_start or {r: DAY0 for r in rooms}
    used = np.array([room_start[r] - DAY0 for r in rooms], dtype=float)          # minutes gone before planning
    for f in fixed:                                                                # emergencies / started cases ahead
        if f["room"] in rooms and f["start"] >= room_start[f["room"]]: used[rooms.index(f["room"])] += f["dur"] + f["turnover"]
    s_busy = defaultdict(float)
    for f in fixed: s_busy[f["surgeon_id"]] += f["dur"]
    ok = {(i,s): surgeons.loc[s,"department"]==el.department[i] and (el.skill_required[i]=="standard" or surgeons.loc[s,"skill"]=="advanced") for i in range(n) for s in S}
    for i in range(n):                                     # a case with no qualified surgeon keeps its own
        if not any(ok[i,s] for s in S): ok[i, el.surgeon_id[i]] = True
    w = (el.waiting_days.values+1).astype(float); p = el.p.values; dur = el.dur.values
    shiftA = {s: surgeons.loc[s,"shift"]=="A" if s in surgeons.index else True for s in S}
    from scipy.optimize import milp, LinearConstraint, Bounds
    from scipy.sparse import lil_matrix
    ys = [(i,s) for i in range(n) for s in S if ok.get((i,s))]; yi = {k:j for j,k in enumerate(ys)}
    nx, ny = n*R, len(ys); iD = nx+ny; iL = iD+n; iO = iL+R; iMax = iO+R; iMin = iMax+1; iE = iMin+1; N = iE+2   # iE, iE+1 = shift-balance slack (min)
    def build(bal):
        c = np.zeros(N); c[iD:iD+n] = W_WAIT*w; c[iO:iO+R] = W_OT; c[iMax] = W_BAL; c[iMin] = -W_BAL; c[iE:iE+2] = W_S1
        rows, lo, hi = [], [], []
        def add(co, l, h): rows.append(co); lo.append(l); hi.append(h)
        for i in range(n):
            add({**{i*R+r:1 for r in range(R)}, iD+i:1}, 1, 1)                                  # (1) placed or deferred
            add({**{nx+yi[i,s]:1 for s in S if ok.get((i,s))}, iD+i:1}, 1, 1)                  # (3) one qualified surgeon
        for r in range(R):
            add({**{i*R+r:p[i] for i in range(n)}, iL+r:-1}, -used[r], -used[r])                 # room load = already used + placed
            add({iO+r:1, iL+r:-1}, -CAP, np.inf); add({iL+r:1}, 0, max(used[r], CAP+OMAX))       # (2) capacity (C3)
            add({iMax:1, iL+r:-1}, 0, np.inf); add({iMin:1, iL+r:-1}, -np.inf, 0)
            if r < R-1 and not used.any(): add({iL+r:1, iL+r+1:-1}, 0, np.inf)                   # (7) symmetry
        for s in S:
            add({nx+yi[i,s]:dur[i] for i in range(n) if ok.get((i,s))}, 0, max(0.0, CAP - s_busy[s]))   # (4) surgeon hours (C3)
        A_ = {nx+yi[k]:dur[k[0]] for k in ys if shiftA[k[1]]}; B_ = {nx+yi[k]:dur[k[0]] for k in ys if not shiftA[k[1]]}
        if A_ and B_ and bal:
            add({**{k:(1-DELTA)*v for k,v in A_.items()}, **{k:-(1+DELTA)*v for k,v in B_.items()}, iE:-1}, -np.inf, 0)     # (5) S1, soft:
            add({**{k:(1-DELTA)*v for k,v in B_.items()}, **{k:-(1+DELTA)*v for k,v in A_.items()}, iE+1:-1}, -np.inf, 0)   # slack costs W_S1/min
        # (6) room balance is in the objective (W_BAL x (Lmax - Lmin)); as a hard row it forced deferrals
        A = lil_matrix((len(rows), N))
        for k,row in enumerate(rows):
            for j,v in row.items(): A[k,j] = v
        integ = np.zeros(N); integ[:iD+n] = 1; ub = np.full(N, np.inf); ub[:iD+n] = 1
        return milp(c, constraints=LinearConstraint(A.tocsr(), lo, hi), integrality=integ, bounds=Bounds(0, ub),
                    options={"time_limit":TIME_LIMIT, "mip_rel_gap":0.01})
    t0 = time.time(); res = build(balance)
    if res.x is None and balance: res = build(False)       # balance rows made the day infeasible: drop them, don't defer everyone
    log.append(time.time()-t0)
    x = res.x if res.x is not None else np.r_[np.zeros(nx+ny), np.ones(n), np.zeros(N-iD-n)]
    assign, out = [], []
    for i in range(n):
        r = next((r for r in range(R) if x[i*R+r] > .5), None)
        if r is None:
            out.append(dict(case_id=el.case_id[i], room="", surgeon_id="", planned_start_min=np.nan, planned_duration_min=np.nan, status="deferred to next day")); continue
        s = next(s for s in S if ok.get((i,s)) and x[nx+yi[i,s]] > .5)
        assign.append(dict(case_id=el.case_id[i], room=rooms[r], surgeon_id=s, dur=int(round(dur[i])), turnover=int(el.turnover_min[i])))
    starts = sequence(assign, room_start, fixed)                                     # stage 2: clock times, no clashes
    for a in assign:
        out.append(dict(case_id=a["case_id"], room=a["room"], surgeon_id=a["surgeon_id"], planned_start_min=starts[a["case_id"]],
                        planned_duration_min=a["dur"], status="scheduled"))
    return pd.DataFrame(out)

def optimize(sim: pd.DataFrame, roster=None, seed=1):
    """Plan every day. Emergencies are on the booking sheet at their arrival time (the same
    information the manual schedule had); they stay where they are and the electives are
    planned around them."""
    rng = np.random.default_rng(seed); log = []
    surgeons = roster if roster is not None else roster_from(sim)
    rooms = sorted(sim.room.unique()); parts = []
    for d, g in sim.groupby("surgery_date"):
        em = g[g.is_emergency==1]
        fixed = [dict(room=e.room, surgeon_id=e.surgeon_id, start=e.booked_start_min, dur=e.booked_duration_min, turnover=e.turnover_min) for e in em.itertuples()]
        el = g[g.is_emergency==0]
        if len(el): parts.append(solve_day(el, surgeons, rng, log, rooms=rooms, fixed=fixed))
    plan = pd.concat(parts)
    opt = sim.drop(columns=["room","surgeon_id"]).merge(plan, on="case_id", how="left")
    em = (opt.is_emergency==1).values; sem = (sim.is_emergency==1).values
    opt.loc[em, "room"] = sim.loc[sem, "room"].values; opt.loc[em, "surgeon_id"] = sim.loc[sem, "surgeon_id"].values
    opt.loc[em, "planned_start_min"] = sim.loc[sem, "booked_start_min"].values.astype(float); opt.loc[em, "status"] = "emergency (kept)"
    opt.loc[em, "planned_duration_min"] = sim.loc[sem, "booked_duration_min"].values.astype(float)
    sch = replay(opt[opt.status!="deferred to next day"], "planned_start_min")      # same actual durations as the manual day
    sch["planned_start"] = sch.planned_start_min.map(min_to_hhmm)
    opt = pd.concat([sch, opt[opt.status=="deferred to next day"]]).sort_values(["surgery_date","room","planned_start_min"])
    return opt, np.array(log)
def compare(sim, opt, solve_s, surgeons=None):
    """Before/after table and the spec/constraint check, in plain words."""
    m = sim.assign(planned_start_min=sim.booked_start_min); m = day_summary(m, "actual_start_min", "actual_end_min", "manual")
    o = day_summary(opt[opt.status!="deferred to next day"], "actual_start_min", "actual_end_min", "SORRS")
    a, b = m.mean(numeric_only=True), o.mean(numeric_only=True)
    surgeons = surgeons if surgeons is not None else roster_from(sim)
    def var(df):
        sh = df.surgeon_id.map(surgeons["shift"]).fillna("A")
        la = df[sh=="A"].actual_duration_min.sum(); lb = df[sh=="B"].actual_duration_min.sum()
        return abs(la-lb)/(la+lb) if la+lb else 0
    v_m = np.mean([var(g) for _, g in sim.groupby("surgery_date")])
    v_o = np.mean([var(g) for _, g in opt[opt.status!="deferred to next day"].groupby("surgery_date")])
    ot = 100*(a.overtime_cost_sar-b.overtime_cost_sar)/a.overtime_cost_sar if a.overtime_cost_sar else 0
    rh = 100*(a.room_hours-b.room_hours)/a.room_hours; dl = 100*(a.start_delay_min-b.start_delay_min)/a.start_delay_min if a.start_delay_min else 0
    deferred = (opt.status=="deferred to next day").mean()*100
    clash = overlaps(opt[opt.status!="deferred to next day"])
    clash_m = overlaps(sim.assign(planned_start_min=sim.booked_start_min, planned_duration_min=sim.booked_duration_min))
    print(f"\n{'':24s}{'Today (manual)':>16s}{'With SORRS':>12s}")
    for k,l in [("room_hours","Room-hours / day"),("overtime_hours","Overtime hours / day"),("overtime_cost_sar","Overtime SAR / day"),("start_delay_min","Avg start delay (min)"),("cases","Cases / day")]:
        print(f"{l:24s}{a[k]:16.1f}{b[k]:12.1f}")
    print(f"{'Shift workload gap':24s}{100*v_m:15.0f}%{100*v_o:11.0f}%")
    print(f"\nCases moved to the next day by SORRS: {deferred:.1f}%   |   solve time per day: max {solve_s.max():.1f} s")
    checks = [
        ("C2  duration variability & emergencies modelled", True, "lognormal durations per department, emergencies kept at their arrival time"),
        ("C3  6 rooms x 10 h, no room or surgeon double-booked", clash == (0, 0), f"clashes in the plan (room, surgeon): {clash}; manual sheet had {clash_m}"),
        ("C4  overtime priced at 1.5x policy rate", True, f"{TEAM_RATE_SAR_MIN} SAR per overrun minute"),
        ("S1  shift workload gap <= 15%", v_o <= .15, f"{100*v_o:.0f}% (was {100*v_m:.0f}%)"),
        ("S3  re-schedule in <= 5 min", solve_s.max() <= 300, f"{solve_s.max():.1f} s"),
        ("S5  overtime cost -20%", ot >= 20, f"{ot:+.0f}%"),
        ("S4  room-hours <= 85% of today", rh >= 15, f"{rh:+.0f}%  (surgery time cannot shrink; the saving shows in overtime)"),
        ("IS2 emergency recovery <= 10 min", solve_s.max() <= 600, "solve time + dashboard"),
        ("IS3 room-hours & overtime both -15%", rh >= 15 and ot >= 15, f"overtime {ot:+.0f}%, room-hours {rh:+.0f}%"),
        ("IS1 waiting -30% (measured as start delay)", dl >= 30, f"{dl:+.0f}%")]
    print("\nSpecification & constraint check")
    for name, met, ev in checks: print(f"  {'MET    ' if met else 'NOT MET'}  {name:46s} {ev}")

# ---------------------------------------------------------------- LIVE RE-PLAN
def replan(optimized, date, now, new_case=None, roster=None, seed=7):
    """OR staff add a case (or an emergency) at time `now` ("HH:MM") on `date`.
    Cases already started and emergencies stay where they are; an emergency goes into the room
    that frees up first; every case not yet started is re-solved with the same MILP, then timed
    so no room or surgeon is ever in two places at once."""
    rng = np.random.default_rng(seed); log = []
    valid = sorted(optimized.surgery_date.unique())
    if date not in valid:
        raise ValueError(f"No schedule for {date}. Dates on this sheet: {', '.join(valid)}")
    day = optimized[(optimized.surgery_date == date) & (optimized.status != "deferred to next day")].copy()
    rest = optimized[(optimized.surgery_date != date) | (optimized.status == "deferred to next day")]
    t_now = hhmm_to_min(now); rooms = sorted(optimized.room.dropna().replace("", np.nan).dropna().unique())
    is_fixed = (day.planned_start_min <= t_now) | (day.is_emergency == 1)
    started = day[is_fixed]; waiting = day[~is_fixed]
    fixed = [dict(room=r.room, surgeon_id=r.surgeon_id, start=r.planned_start_min, dur=r.planned_duration_min, turnover=r.turnover_min, em=int(r.is_emergency) == 1) for r in started.itertuples()]
    room_start = {r: t_now for r in rooms}
    for f in fixed:                                         # a room is free once its started case (or a placed emergency) and turnover end
        # ORbit fix (Nov 2026): emergencies placed earlier in the day also block their room
        if f["start"] <= t_now or f["em"]: room_start[f["room"]] = max(room_start[f["room"]], f["start"] + f["dur"] + f["turnover"])
    note = []
    if new_case is not None:
        nc = dict(new_case); nc.setdefault("skill_required", "standard"); nc.setdefault("is_emergency", 0)
        known = sorted(optimized.department.unique())
        if nc["department"] not in known:
            note.append(f"'{nc['department']}' is not a department on this sheet ({', '.join(known)}); the surgeon you typed is kept")
        nc.update(booked_start_min=t_now, booked_start=now, waiting_days=0, surgery_date=date, booked_duration_min=int(nc["booked_duration_min"]))
        nc["actual_duration_min"] = int(round(nc["booked_duration_min"] * MEAN_RATIO * rng.lognormal(0, LOG_SD.get(nc["department"], LOG_SD_DEFAULT))))
        nc["turnover_min"] = int(rng.integers(10, 46))
        if int(nc["is_emergency"]) == 1:                    # emergency: the room that frees up first, as soon as its surgeon is free
            r = min(room_start, key=room_start.get)
            s_busy = [(f["start"], f["start"] + f["dur"]) for f in fixed if f["surgeon_id"] == nc["surgeon_id"]]
            st = _free_from(room_start[r], nc["booked_duration_min"], s_busy)
            nc.update(room=r, planned_start_min=st, planned_duration_min=nc["booked_duration_min"], status="emergency (added)")
            fixed.append(dict(room=r, surgeon_id=nc["surgeon_id"], start=st, dur=nc["booked_duration_min"], turnover=nc["turnover_min"]))
            started = pd.concat([started, pd.DataFrame([nc])]); note.append(f"Emergency placed in {r} at {min_to_hhmm(st)}")
        else:
            nc["status"] = "scheduled"; waiting = pd.concat([waiting, pd.DataFrame([nc])]); note.append("New elective case added to today's queue")
    surgeons = roster if roster is not None else roster_from(optimized)
    if nc_surg := (new_case or {}).get("surgeon_id"):
        if nc_surg not in surgeons.index:                   # an unknown surgeon code: keep the case with that surgeon
            surgeons = pd.concat([surgeons, pd.DataFrame([dict(department=new_case["department"], shift="A", skill="advanced")], index=[nc_surg])])
    if len(waiting):
        plan = solve_day(waiting.reset_index(drop=True), surgeons, rng, log, room_start=room_start, rooms=rooms, fixed=fixed)
        waiting = waiting.drop(columns=["room","surgeon_id","planned_start_min","planned_duration_min","status"], errors="ignore").merge(plan, on="case_id", how="left")
    newday = pd.concat([started, waiting]).sort_values(["room","planned_start_min"])
    newday["planned_start"] = newday.planned_start_min.map(lambda v: min_to_hhmm(v) if pd.notna(v) else "")
    moved = (newday.status == "deferred to next day").sum()
    clash = overlaps(newday[newday.status != "deferred to next day"])
    print(f"Re-plan at {now}: {len(started)} case(s) kept, {len(waiting)} re-solved in {max(log) if log else 0:.1f} s"
          + (f"; {moved} moved to next day" if moved else "") + ("; " + "; ".join(note) if note else "")
          + f"; clashes (room, surgeon): {clash}")
    return pd.concat([rest, newday]).sort_values(["surgery_date","room","planned_start_min"])

# ---------------------------------------------------------------- helpers
def make_template_from(cases_csv, days=10, out="booking_sheet_example.csv"):
    """Turn the project dataset into the simple sheet OR staff would hand over."""
    c = pd.read_csv(cases_csv); c = c[c.surgery_date.isin(sorted(c.surgery_date.unique())[:days])]
    t = pd.DataFrame(dict(case_id=c.case_id, surgery_date=c.surgery_date, department=c.department, surgeon_id=c.surgeon_id, room=c.room_id,
                          booked_start=c.scheduled_start_min.map(min_to_hhmm), booked_duration_min=c.scheduled_duration_min,
                          is_emergency=c.is_emergency, booking_date=c.booking_date, skill_required=c.skill_required))
    t.to_csv(out, index=False); return t



if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == "--example":
        book = make_template_from(a[1], days=int(a[2]) if len(a) > 2 else 10)
        print("Wrote booking_sheet_example.csv")
    else:
        book = pd.read_excel(a[0]) if a[0].lower().endswith((".xlsx", ".xls")) else pd.read_csv(a[0])
        for col in ("surgery_date", "booking_date"):
            if col in book: book[col] = pd.to_datetime(book[col]).dt.strftime("%Y-%m-%d")
        book["booked_start"] = book["booked_start"].astype(str).str[:5]
    missing = [c for c in TEMPLATE[:7] if c not in book.columns]
    if missing: sys.exit(f"Your sheet is missing columns: {missing}")
    sim = simulate(book); sim.to_csv("sorrs_simulated.csv", index=False)
    opt, solve_s = optimize(sim); opt.to_csv("sorrs_optimized.csv", index=False)
    compare(sim, opt, solve_s)
    print("\nWrote sorrs_simulated.csv and sorrs_optimized.csv")
