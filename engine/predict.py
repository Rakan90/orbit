"""
ICS duration model for Specification 2: >= 85% of cases in a held-out test set predicted within +/-15% of the
actual duration, reported with the mean absolute error and a per-department breakdown.

Model: log-linear regression (least squares on log minutes) with
  log(booked duration), department, surgeon, complexity, ASA class, BMI band, age band, anaesthesia.
Trained on 80% of database/data/duration_history.csv, tested on the other 20% (fixed split, seed 7).
Nothing about how the data was generated is given to the model; it learns every effect from the history.

    python3 predict.py        prints the held-out evaluation
"""
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY = os.path.join(HERE, "..", "database", "data", "duration_history.csv")
FEATURES = ["department", "surgeon_id", "complexity", "asa_class", "bmi_band", "age_band", "anaesthesia"]
BAND, TARGET, TEST_SHARE, SPLIT_SEED = 0.15, 85.0, 0.20, 7


class DurationModel:
    def __init__(self):
        self.columns, self.coef, self.levels = None, None, None

    def _design(self, df):
        X = pd.DataFrame({"intercept": 1.0, "log_booked": np.log(df.booked_duration_min.astype(float))}, index=df.index)
        for c in FEATURES:
            for lv in self.levels[c][1:]:                                   # first level is the reference
                X[f"{c}={lv}"] = (df[c].astype(str) == lv).astype(float)
        return X[self.columns] if self.columns is not None else X

    def fit(self, df):
        self.levels = {c: sorted(df[c].astype(str).unique()) for c in FEATURES}
        X = self._design(df); self.columns = list(X.columns)
        self.coef, *_ = np.linalg.lstsq(X.to_numpy(), np.log(df.actual_duration_min.astype(float)).to_numpy(), rcond=None)
        resid = np.log(df.actual_duration_min) - X.to_numpy() @ self.coef
        self.smear = float(np.median(np.exp(resid)))                       # median correction back to minutes
        return self

    def can_predict(self, df):
        return all(c in df for c in FEATURES) and df[FEATURES].notna().all(axis=None)

    def predict(self, df):
        return np.round(np.exp(self._design(df).to_numpy() @ self.coef) * self.smear).astype(int)


def evaluate(pred, actual, groups):
    err = pred / actual - 1
    inside = np.abs(err) <= BAND
    by = (pd.DataFrame({"g": groups, "inside": inside, "ae": np.abs(pred - actual)}).groupby("g")
          .agg(cases=("inside", "size"), within15=("inside", "mean"), mae=("ae", "mean")))
    return {"cases": int(len(actual)), "within15": round(100 * float(inside.mean()), 1),
            "maeMin": round(float(np.mean(np.abs(pred - actual))), 1),
            "mapePct": round(100 * float(np.mean(np.abs(err))), 1),
            "byDepartment": [{"department": g, "cases": int(r.cases), "within15": round(100 * r.within15, 1), "maeMin": round(r.mae, 1)}
                             for g, r in by.iterrows()]}


def train(path=HISTORY):
    """Fit on the training share of the history and evaluate on the held-out share."""
    hist = pd.read_csv(path, dtype={"asa_class": str})
    rng = np.random.default_rng(SPLIT_SEED)
    test = rng.random(len(hist)) < TEST_SHARE
    model = DurationModel().fit(hist[~test])
    ev = evaluate(model.predict(hist[test]), hist.actual_duration_min[test].to_numpy(), hist.department[test].to_numpy())
    booked = evaluate(np.round(hist.booked_duration_min[test].to_numpy() * 1.05).astype(int), hist.actual_duration_min[test].to_numpy(),
                      hist.department[test].to_numpy())
    model.report = {"model": "log-linear regression on log minutes", "features": ["log booked duration"] + FEATURES,
                    "trainCases": int((~test).sum()), "test": ev, "bookedOnly": {"within15": booked["within15"], "maeMin": booked["maeMin"]},
                    "band": BAND, "target": TARGET, "met": ev["within15"] >= TARGET}
    return model


if __name__ == "__main__":
    m = train()
    r = m.report
    print(f"trained on {r['trainCases']} cases; held-out test {r['test']['cases']} cases")
    print(f"within +/-15%: {r['test']['within15']}% (target {TARGET}%) -> {'MET' if r['met'] else 'NOT MET'}; "
          f"MAE {r['test']['maeMin']} min; MAPE {r['test']['mapePct']}%")
    print(f"booking alone (x1.05): {r['bookedOnly']['within15']}% within +/-15%, MAE {r['bookedOnly']['maeMin']} min")
    for d in r["test"]["byDepartment"]:
        print(f"  {d['department']:18s} {d['cases']:4d} cases  {d['within15']:5.1f}%  MAE {d['maeMin']} min")
    sheet = pd.read_csv(os.path.join(HERE, "..", "database", "data", "booking_sheet_spec2.csv"), dtype={"asa_class": str})
    e = evaluate(m.predict(sheet), sheet.sim_true_duration_min.to_numpy(), sheet.department.to_numpy())
    print(f"on the 241-case booking sheet: {e['within15']}% within +/-15%, MAE {e['maeMin']} min")
