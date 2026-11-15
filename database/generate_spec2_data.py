"""
Synthetic data for Specification 2 (duration prediction), Constraint 1 safe: no patient identifiers.

Writes two files into database/data/:
  booking_sheet_spec2.csv   V2's 241 cases unchanged (same days, surgeons, rooms, booking times, booked
                            durations, emergencies) plus five non-identifying clinical factors and the
                            simulated true duration (sim_true_duration_min, used only by the simulation).
  duration_history.csv      3,000 past cases of the same departments and surgeons, generated the same way;
                            the ICS model is trained on 80% of it and tested on the held-out 20%.

How a true duration is made (the model never reads this table, it has to learn it):
  true = booked x 1.05 x surgeon pace x complexity x ASA x BMI x age x anaesthesia x residual
  residual ~ log-normal(0, 0.09): the part no factor explains.
Assumption, stated openly: about 90% of the variation of real durations around the booking is explained
by recorded factors. The report's Eq. 4.2 shows Spec 2 is attainable only if the unexplained log-spread
is <= 0.105; this dataset is built on that premise. Variation around the booking stays about +/-30%
(Constraint 2).

Run:  python3 generate_spec2_data.py      (deterministic, seed 2026)
"""
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
SEED, RESIDUAL_SD, MEAN_RATIO = 2026, 0.09, 1.05

# log-effects (0 = reference level) and how often each level occurs
COMPLEXITY = {"simple": (-0.30, .30), "standard": (0.0, .45), "complex": (0.38, .25)}
ASA = {"1": (-0.08, .25), "2": (0.0, .45), "3": (0.15, .25), "4": (0.30, .05)}
BMI = {"<25": (-0.05, .35), "25-30": (0.0, .35), "30-35": (0.08, .20), ">=35": (0.18, .10)}
AGE = {"<40": (-0.04, .30), "40-64": (0.0, .45), ">=65": (0.09, .25)}
ANAESTHESIA = {"general": (0.0, .75), "regional": (-0.10, .20), "local": (-0.22, .05)}
FACTORS = {"complexity": COMPLEXITY, "asa_class": ASA, "bmi_band": BMI, "age_band": AGE, "anaesthesia": ANAESTHESIA}
SURGEON_PACE_SD = 0.16                     # each surgeon is consistently faster or slower than the booking assumes


def draw_factors(rng, n):
    out = {}
    for col, levels in FACTORS.items():
        keys = list(levels); p = np.array([levels[k][1] for k in keys]); p = p / p.sum()
        out[col] = rng.choice(keys, size=n, p=p)
    return pd.DataFrame(out)


def true_duration(rng, booked, factors, pace):
    log_eff = sum(factors[c].map({k: v[0] for k, v in FACTORS[c].items()}).to_numpy() for c in FACTORS)
    return np.maximum(10, np.round(booked * MEAN_RATIO * np.exp(log_eff + pace + rng.normal(0, RESIDUAL_SD, len(booked))))).astype(int)


def main():
    rng = np.random.default_rng(SEED)
    sheet = pd.read_csv(os.path.join(DATA, "booking_sheet_example.csv"))
    surgeons = sorted(sheet.surgeon_id.unique())
    pace = dict(zip(surgeons, rng.normal(0, SURGEON_PACE_SD, len(surgeons))))

    # 1. V2's sheet + factors + simulated truth
    f = draw_factors(rng, len(sheet))
    out = pd.concat([sheet.reset_index(drop=True), f], axis=1)
    out["sim_true_duration_min"] = true_duration(rng, out.booked_duration_min.to_numpy(), f, out.surgeon_id.map(pace).to_numpy())
    out.to_csv(os.path.join(DATA, "booking_sheet_spec2.csv"), index=False)

    # 2. history: same departments and surgeons, booked durations drawn from V2's own mix per department
    n = 3000
    dept_mix = sheet.department.value_counts(normalize=True)
    dept = rng.choice(dept_mix.index, size=n, p=dept_mix.values)
    surg = [rng.choice(sheet.loc[sheet.department == d, "surgeon_id"].unique()) for d in dept]
    booked = np.array([rng.choice(sheet.loc[sheet.department == d, "booked_duration_min"].to_numpy()) for d in dept])
    days = pd.to_datetime("2025-01-05") + pd.to_timedelta(rng.integers(0, 350, n), unit="D")
    hf = draw_factors(rng, n)
    hist = pd.DataFrame({"case_id": [f"H{i:05d}" for i in range(1, n + 1)], "surgery_date": days.strftime("%Y-%m-%d"),
                         "department": dept, "surgeon_id": surg, "booked_duration_min": booked, **hf})
    hist["actual_duration_min"] = true_duration(rng, booked, hf, hist.surgeon_id.map(pace).to_numpy())
    hist.sort_values(["surgery_date", "case_id"]).to_csv(os.path.join(DATA, "duration_history.csv"), index=False)

    r = np.log(out.sim_true_duration_min / out.booked_duration_min)
    w30 = ((out.sim_true_duration_min / out.booked_duration_min - 1).abs() <= .30).mean()
    print(f"sheet: {len(out)} cases; log-spread around booking {r.std():.3f}; within +/-30% of booking {100*w30:.0f}% (Constraint 2)")
    print(f"history: {len(hist)} cases")


if __name__ == "__main__":
    main()
