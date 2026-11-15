"""
Engine checks on V2's own data (../database/data).
Run:  .venv/bin/python -m unittest -v test_engine.py      (about 1 minute)
"""
import csv
import os
import unittest

import service

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

    def test_optimize_v2_mode_matches_v2_plan_without_clashes(self):
        out = service.optimize({"rows": self.sim["rows"], "roster": self.sim["roster"], "mode": "v2"})
        self.assertEqual(out["clashes"], [0, 0])
        status = {"scheduled": "scheduled", "emergency (kept)": "emergency", "deferred to next day": "deferred"}
        same = total = 0
        for it in out["items"]:
            ref = self.opt_ref[it["case_id"]]
            for k in ("room", "surgeon_id", "planned_start_min"):
                total += 1
                same += str(it[k] if it[k] is not None else "") == str(ref[k]).replace(".0", "")
            total += 1
            same += status[ref["status"]] == it["status"]
        print(f"\n  V2 mode: {same}/{total} fields identical to V2's sorrs_optimized.csv; solve {out['solveS']}")
        self.assertGreater(same / total, 0.95)
        self.assertLess(max(out["solveS"].values()), 300)          # Spec 3 budget per day

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
