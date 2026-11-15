"""
Specification 2 (ICS duration model) and planning with its predictions.
Run:  .venv/bin/python -m unittest -v test_spec2.py
"""
import csv
import os
import unittest

import pandas as pd

import predict
import service
from service import v2

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "database", "data")


def sheet_rows():
    with open(os.path.join(DATA, "booking_sheet_spec2.csv")) as f:
        return [{k: (int(v) if k in ("booked_duration_min", "is_emergency", "sim_true_duration_min") else v) for k, v in r.items()}
                for r in csv.DictReader(f)]


class Spec2(unittest.TestCase):
    def test_held_out_accuracy_meets_spec2(self):
        r = predict.train().report
        print(f"\n  held-out {r['test']['cases']} cases: {r['test']['within15']}% within +/-15%, MAE {r['test']['maeMin']} min "
              f"(booking alone {r['bookedOnly']['within15']}%)")
        self.assertGreaterEqual(r["test"]["cases"], 500)
        self.assertGreaterEqual(r["test"]["within15"], 85.0)
        self.assertTrue(r["met"])
        self.assertEqual(len(r["test"]["byDepartment"]), 5)                      # per-department breakdown is reported

    def test_test_cases_are_not_used_in_training(self):
        r = predict.train().report
        hist = pd.read_csv(predict.HISTORY)
        self.assertEqual(r["trainCases"] + r["test"]["cases"], len(hist))

    def test_dataset_keeps_v2_cases_and_constraint_2(self):
        s2 = pd.read_csv(os.path.join(DATA, "booking_sheet_spec2.csv"))
        v2s = pd.read_csv(os.path.join(DATA, "booking_sheet_example.csv"))
        pd.testing.assert_frame_equal(s2[v2s.columns], v2s)                       # same 241 cases as V2
        w30 = ((s2.sim_true_duration_min / s2.booked_duration_min - 1).abs() <= .30).mean()
        self.assertTrue(0.55 <= w30 <= 0.75, w30)                                # durations still vary about +/-30%

    def test_planning_with_predictions_meets_specs_3_5_and_is1(self):
        sim = service.simulate({"rows": sheet_rows()})
        S = pd.DataFrame(sim["rows"])
        self.assertTrue(S.predicted_duration_min.notna().all())
        out = service.optimize({"rows": sim["rows"], "roster": sim["roster"], "mode": "predicted"})
        self.assertEqual(out["clashes"], [0, 0])
        self.assertLess(max(out["solveS"].values()), 300)                        # Spec 3 (full-day solve)
        it = pd.DataFrame(out["items"])
        sch = it[it.status != "deferred"].merge(S[["case_id", "actual_duration_min", "turnover_min"]], on="case_id")
        sch["actual_end_min"] = sch.actual_start_min + sch.actual_duration_min
        m = v2.day_summary(S.assign(planned_start_min=S.booked_start_min), "actual_start_min", "actual_end_min", "m").mean(numeric_only=True)
        o = v2.day_summary(sch, "actual_start_min", "actual_end_min", "o").mean(numeric_only=True)
        ot = 100 * (1 - o.overtime_cost_sar / m.overtime_cost_sar)
        dl = 100 * (1 - o.start_delay_min / m.start_delay_min)
        print(f"\n  predicted mode: overtime -{ot:.0f}%, start delay -{dl:.0f}%")
        self.assertGreaterEqual(ot, 20)                                          # Spec 5
        self.assertGreaterEqual(dl, 30)                                          # Integrated Spec 1


if __name__ == "__main__":
    unittest.main()
