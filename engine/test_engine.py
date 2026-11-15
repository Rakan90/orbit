"""
Engine checks on V2's own data (../database/data).
Run:  .venv/bin/python -m unittest -v test_engine.py      (about 1 minute)
"""
import csv
import os
import unittest

import pandas as pd

import service
from service import v2

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "database", "data")


def rows(name):
    with open(os.path.join(DATA, name)) as f:
        return list(csv.DictReader(f))


def num(r, keys):
    for k in keys:
        if k in r and r[k] not in ("", None):
            r[k] = float(r[k]) if "." in str(r[k]) else int(r[k])
    return r


INTS = ["booked_duration_min", "is_emergency", "booked_start_min", "actual_duration_min", "turnover_min",
        "waiting_days", "actual_start_min", "planned_start_min", "planned_duration_min"]


class V2Data(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.book = rows("booking_sheet_example.csv")
        cls.sim_ref = [num(r, INTS) for r in rows("sorrs_simulated.csv")]
        cls.opt_ref = {r["case_id"]: r for r in rows("sorrs_optimized.csv")}
        cls.sim = service.simulate({"rows": [num(dict(r), INTS) for r in cls.book]})

    def test_simulate_reproduces_v2(self):
        got = {r["case_id"]: r for r in self.sim["rows"]}
        for ref in self.sim_ref:
            g = got[ref["case_id"]]
            for k in ("actual_duration_min", "turnover_min", "waiting_days", "actual_start_min"):
                self.assertEqual(float(g[k]), float(ref[k]), (ref["case_id"], k))
        self.assertEqual(len(self.sim["roster"]), 20)

    def test_v2_mode_rerun_no_clashes_and_v2_specifications_still_met(self):
        """V2 mode re-run: no clashes and V2's specifications still met."""
        out = service.optimize({"rows": self.sim["rows"], "roster": self.sim["roster"], "mode": "v2"})
        # 1. no room or surgeon clashes
        self.assertEqual(out["clashes"], [0, 0])
        # 2. every case in the result exactly once, as scheduled, emergency or deferred
        ids = [it["case_id"] for it in out["items"]]
        self.assertEqual(sorted(ids), sorted(r["case_id"] for r in self.sim["rows"]))
        self.assertTrue(all(it["status"] in ("scheduled", "emergency", "deferred") for it in out["items"]))
        # 3. Spec 3: slowest day solves in under 5 minutes
        self.assertLess(max(out["solveS"].values()), 300)
        # 4./5. Spec 5 and Integrated Spec 1, computed as sorrs_tool_v2.compare() does (day_summary, mean over days)
        sim = pd.DataFrame(self.sim["rows"])
        m = v2.day_summary(sim.assign(planned_start_min=sim.booked_start_min), "actual_start_min", "actual_end_min", "manual")
        sched = pd.DataFrame([it for it in out["items"] if it["status"] != "deferred"])
        sched = sched.merge(sim[["case_id", "actual_duration_min", "turnover_min"]], on="case_id")
        o = v2.day_summary(sched, "actual_start_min", "actual_end_min", "SORRS")
        a, b = m.mean(numeric_only=True), o.mean(numeric_only=True)
        ot = 100 * (a.overtime_cost_sar - b.overtime_cost_sar) / a.overtime_cost_sar if a.overtime_cost_sar else 0
        dl = 100 * (a.start_delay_min - b.start_delay_min) / a.start_delay_min if a.start_delay_min else 0
        # 6. deferred electives at most 5% of electives
        em = {r["case_id"]: int(r["is_emergency"]) for r in self.sim["rows"]}
        electives = [it for it in out["items"] if not em[it["case_id"]]]
        deferred = 100 * sum(it["status"] == "deferred" for it in electives) / len(electives)
        # Information only: HiGHS may stop at a different plan within mip_rel_gap 0.01 on another platform,
        # so a field-for-field match with V2's sorrs_optimized.csv is platform-dependent and not asserted.
        status = {"scheduled": "scheduled", "emergency (kept)": "emergency", "deferred to next day": "deferred"}
        same = total = 0
        for it in out["items"]:
            ref = self.opt_ref[it["case_id"]]
            for k in ("room", "surgeon_id", "planned_start_min"):
                total += 1
                same += str(it[k] if it[k] is not None else "") == str(ref[k]).replace(".0", "")
            total += 1
            same += status[ref["status"]] == it["status"]
        print(f"\n  V2 mode re-run: overtime cost/day {a.overtime_cost_sar:.0f} -> {b.overtime_cost_sar:.0f} SAR ({ot:+.0f}%), "
              f"start delay {a.start_delay_min:.1f} -> {b.start_delay_min:.1f} min ({dl:+.0f}%), "
              f"deferred electives {deferred:.1f}%, slowest day {max(out['solveS'].values())} s; "
              f"{same}/{total} fields identical to V2's sorrs_optimized.csv (info)")
        self.assertGreaterEqual(ot, 20)          # Spec 5: overtime cost -20%
        self.assertGreaterEqual(dl, 30)          # Integrated Spec 1: start delay -30%
        self.assertLessEqual(deferred, 5)        # deferred electives <= 5%

    def test_booked_mode_plans_without_actual_durations(self):
        out = service.optimize({"rows": self.sim["rows"], "roster": self.sim["roster"], "mode": "booked"})
        self.assertEqual(out["clashes"], [0, 0])
        booked = {r["case_id"]: int(r["booked_duration_min"]) for r in self.sim["rows"]}
        for it in out["items"]:
            if it["status"] == "scheduled":
                # planned = booked x 1.05 safety buffer, never the actual duration
                self.assertEqual(it["planned_duration_min"], int(round(booked[it["case_id"]] * 1.05)), it["case_id"])

    def test_replan_emergency_no_clashes(self):
        day = "2026-01-05"
        plan = []
        sim = {r["case_id"]: r for r in self.sim["rows"]}
        for cid, ref in self.opt_ref.items():
            if ref["surgery_date"] != day:
                continue
            s = sim[cid]
            st = {"scheduled": "scheduled", "emergency (kept)": "emergency", "deferred to next day": "deferred"}[ref["status"]]
            plan.append({**s, "room": ref["room"] or None, "surgeon_id": ref["surgeon_id"] or None, "status": st,
                         "planned_start_min": float(ref["planned_start_min"]) if ref["planned_start_min"] else None,
                         "planned_duration_min": float(ref["planned_duration_min"]) if ref["planned_duration_min"] else None})
        out = service.replan({"date": day, "rows": plan, "roster": self.sim["roster"], "nowMin": 630, "mode": "booked",
                              "newCase": {"case_id": "E00001", "department": "General surgery", "surgeon_id": "SUR001",
                                          "booked_duration_min": 90, "is_emergency": 1}})
        self.assertEqual(out["clashes"], [0, 0])
        self.assertLess(out["solveS"], 300)
        em = out["emergency"]
        self.assertGreaterEqual(em["start_min"], 630)
        ids = {i["case_id"] for i in out["items"]}
        self.assertIn("E00001", ids)
        self.assertTrue({c for c in sim if sim[c]["surgery_date"] == day} <= ids)
        print(f"\n  re-plan: emergency in {em['room']} at {em['start_min']} min, {out['moved']} moved, "
              f"solve {out['solveS']} s, clashes {out['clashes']}")


if __name__ == "__main__":
    unittest.main()
