#!/usr/bin/env python3
"""
Next-season championship prediction for the website's "2027 Prediction" page.

The same method as ml/02_season_2027.ipynb (which explains every step):
  1. Plackett-Luce strength for every driver in every season (finishers only)
  2. regression: how much of a car's and a driver's strength carries into the next season
  3. how far teams and drivers typically land from that prediction (minus measurement noise)
  4. Monte Carlo: simulate the next season 10,000 times
plus a walk-forward backtest of the whole method on 2016-2024.

    python warehouse/build_warehouse.py      # first, so the warehouse has the latest races
    python ml/predict_next_season.py         # writes predictions/next-season.json

Needs numpy, pandas and scipy. The site only reads the JSON, so commit it after
re-running; GitHub Actions publishes it with the rest of the site.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import spearmanr

ROOT = Path(__file__).resolve().parent.parent
WAREHOUSE = ROOT / "data" / "warehouse.db"
OUT = ROOT / "predictions" / "next-season.json"

N_RACES = 24            # next season's calendar isn't published yet
N_SIMS = 10_000
LINEUP_CHANGES: dict[str, str | None] = {
    # "driver_ref": "constructor_ref" moves a driver, a new name adds a rookie, None removes a driver
}

# teams that changed name: one lineage each, so a car's form carries over the rename
LINEAGE = {"lotus_f1": "enstone", "renault": "enstone", "alpine": "enstone",
           "force_india": "silverstone", "racing_point": "silverstone", "aston_martin": "silverstone",
           "toro_rosso": "faenza", "alphatauri": "faenza", "rb": "faenza",
           "sauber": "hinwil", "alfa": "hinwil", "audi": "hinwil",
           "marussia": "banbury", "manor": "banbury"}
FEATURES = ["team_prev", "driver_edge", "rookie"]
POINTS = np.array([25, 18, 15, 12, 10, 8, 6, 4, 2, 1])


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
def pl_neg_log_likelihood(s, orders, ridge):
    loss, grad = ridge / 2 * s @ s, ridge * s
    for o in orders:                               # o = driver indices in finishing order
        x = s[o]
        e = np.exp(x - x.max())
        remaining = np.cumsum(e[::-1])[::-1]       # at each pick: total exp(strength) of drivers still unplaced
        loss -= (np.log(e) - np.log(remaining)).sum()
        np.subtract.at(grad, o, 1 - e * np.cumsum(1 / remaining))
    return loss, grad


def fit_pl(races, ridge=0.05):
    """Plackett-Luce strengths. races: lists of driver_ref in finishing order, winner first."""
    drivers = sorted({d for race in races for d in race})
    idx = {d: i for i, d in enumerate(drivers)}
    orders = [np.array([idx[d] for d in race]) for race in races]
    res = minimize(pl_neg_log_likelihood, np.zeros(len(drivers)), args=(orders, ridge), jac=True, method="L-BFGS-B")
    return pd.Series(res.x - res.x.mean(), index=drivers)


def season_races(df, season, finishers_only=True):
    part = df[df.season == season]
    if finishers_only:
        part = part[part.finished == 1]
    return [race.sort_values("pos").driver_ref.tolist() for _, race in part.groupby("race_key")]


def season_strengths(df):
    rows = []
    for season, part in df.groupby("season"):
        races = season_races(df, season)
        info = part.groupby("driver_ref").agg(races=("race_key", "size"), team=("team", lambda t: t.mode()[0]),
                                              constructor_ref=("constructor_ref", lambda t: t.mode()[0]),
                                              pts=("pts", "sum"))
        info["strength"] = fit_pl(races)
        info["half_diff"] = fit_pl(races[0::2]) - fit_pl(races[1::2])   # odd races vs even races
        info["season"] = season
        rows.append(info.reset_index())
    strengths = pd.concat(rows, ignore_index=True).dropna(subset=["strength"])
    team_strength = (strengths.groupby(["season", "team"])
                     .apply(lambda g: np.average(g.strength, weights=g.races), include_groups=False)
                     .rename("team_strength"))
    return strengths, team_strength


def features(lineup, prev_season, strengths, team_strength):
    """Pre-season features for each (driver_ref, team) row of lineup, taken from prev_season."""
    prev = strengths[strengths.season == prev_season].set_index("driver_ref")
    teams_prev = team_strength.loc[prev_season]
    out = lineup.copy()
    out["new_team"] = ~out.team.isin(teams_prev.index)
    out["team_prev"] = out.team.map(teams_prev).fillna(teams_prev.min())    # a brand-new team starts at the back
    known = out.driver_ref.isin(prev.index[prev.races >= 3])
    p = prev.reindex(out.driver_ref)
    out["driver_edge"] = np.where(known, p.strength.to_numpy() - p.team.map(teams_prev).to_numpy(), 0.0)
    out["rookie"] = (~known).astype(float)
    return out


def fit_carryover(train, strengths):
    """Regression weights + team and driver surprise, learned only from the seasons in train."""
    X = np.c_[np.ones(len(train)), train[FEATURES].to_numpy()]
    beta, *_ = np.linalg.lstsq(X, train.strength.to_numpy(), rcond=None)
    r = train.assign(resid=train.strength.to_numpy() - X @ beta)
    known = strengths[(strengths.races >= 10) & (strengths.season <= train.season.max())]
    noise2 = known.half_diff.var() / 4
    team_mean = r.groupby(["season", "team"]).resid.transform("mean")
    var_within = (r.resid - team_mean).var()
    var_team = r.groupby(["season", "team"]).resid.mean().var()
    sigma_driver = np.sqrt(max(2 * var_within - noise2, 0))
    sigma_team = np.sqrt(max(var_team - sigma_driver**2 / 2 - noise2 / 2, 0))
    return pd.Series(beta, index=["intercept"] + FEATURES), sigma_team, sigma_driver, np.sqrt(noise2)


def predict(beta, part):
    return beta["intercept"] + part[FEATURES].to_numpy() @ beta[FEATURES].to_numpy()


def simulate_season(lineup, mu, sigma_team, sigma_driver, n_races, dnf_rate, n_sims=N_SIMS, seed=0):
    """Points per driver in n_sims simulated seasons -> array (n_sims, n_drivers)."""
    rng = np.random.default_rng(seed)
    n = len(lineup)
    _, team_idx = np.unique(lineup.team.to_numpy(), return_inverse=True)
    strength = (mu[None, :]
                + rng.normal(0, sigma_team, (n_sims, team_idx.max() + 1))[:, team_idx]
                + rng.normal(0, sigma_driver, (n_sims, n)))
    perf = strength[:, None, :] + rng.gumbel(size=(n_sims, n_races, n))
    perf[rng.random(perf.shape) < dnf_rate] = -np.inf
    rank = np.argsort(np.argsort(-perf, axis=2), axis=2)
    pts = np.where(rank < len(POINTS), POINTS[np.minimum(rank, len(POINTS) - 1)], 0)
    pts[np.isinf(perf)] = 0
    return pts.sum(axis=1)


# ---------------------------------------------------------------------------
# Build the prediction
# ---------------------------------------------------------------------------
def r(x, nd=4):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), nd)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if not WAREHOUSE.exists():
        print(f"{WAREHOUSE.relative_to(ROOT)} not found: run python warehouse/build_warehouse.py first")
        return 1
    started = time.monotonic()

    with sqlite3.connect(WAREHOUSE) as con:
        df = pd.read_sql("""
            SELECT season, round, race_key, driver_ref, constructor_ref,
                   target_position_order AS pos, target_points_std AS pts,
                   target_status_category IN ('finished', 'lapped') AS finished
            FROM ml_driver_race
            WHERE season >= 2013 AND target_did_start = 1""", con)
        drivers_dim = pd.read_sql("SELECT driver_ref, given_name, family_name, code FROM dim_driver", con).set_index("driver_ref")
        teams_dim = pd.read_sql("SELECT constructor_ref, name FROM dim_constructor", con).set_index("constructor_ref").name
        races_dim = pd.read_sql("SELECT season, round, race_name, race_date FROM dim_race", con)
    df["team"] = df.constructor_ref.map(LINEAGE).fillna(df.constructor_ref)

    last = int(df.season.max())
    target = last + 1
    last_round = int(df[df.season == last]["round"].max())
    rounds_in_season = int((races_dim.season == last).sum())
    last_race = races_dim[(races_dim.season == last) & (races_dim["round"] == last_round)].iloc[0]

    def driver_name(ref):
        if ref in drivers_dim.index:
            d = drivers_dim.loc[ref]
            return f"{d.given_name} {d.family_name}", d.code or d.family_name[:3].upper()
        return ref.replace("_", " ").title(), ref[:3].upper()

    def team_name(ref):
        return teams_dim.get(ref, ref.replace("_", " ").title())

    # 1. strengths ------------------------------------------------------------
    strengths, team_strength = season_strengths(df)
    seasons = sorted(strengths.season.unique())
    pairs = pd.concat([features(strengths[(strengths.season == y) & (strengths.races >= 5)], y - 1, strengths, team_strength)
                       for y in seasons if y - 1 in seasons], ignore_index=True)

    dnf_by_season = 1 - df.groupby("season").finished.mean()
    recent_dnf_rate = lambda before: float(dnf_by_season[dnf_by_season.index < before].tail(3).mean())

    # 2-3. carry-over and surprise --------------------------------------------
    beta, sigma_team, sigma_driver, noise = fit_carryover(pairs, strengths)

    # 4. next season ------------------------------------------------------------
    last_grid = df[(df.season == last) & (df["round"] == last_round)]
    seats = dict(zip(last_grid.driver_ref, last_grid.constructor_ref)) | LINEUP_CHANGES
    lineup = pd.DataFrame(seats.items(), columns=["driver_ref", "constructor_ref"]).dropna().reset_index(drop=True)
    lineup["team"] = lineup.constructor_ref.map(LINEAGE).fillna(lineup.constructor_ref)
    field = features(lineup, last, strengths, team_strength)
    mu = predict(beta, field)
    dnf_rate = recent_dnf_rate(target)
    pts = simulate_season(field, mu, sigma_team, sigma_driver, N_RACES, dnf_rate)
    n_sims, n = pts.shape
    final_pos = np.argsort(np.argsort(-pts, axis=1), axis=1) + 1
    pct = np.percentile(pts, [10, 25, 50, 75, 90], axis=0)
    prev_strength = strengths[strengths.season == last].set_index("driver_ref")

    drivers_out = []
    for i, row in field.iterrows():
        name, code = driver_name(row.driver_ref)
        prev = prev_strength.strength.get(row.driver_ref)
        drivers_out.append({
            "id": row.driver_ref, "name": name, "code": code,
            "teamId": row.constructor_ref, "team": team_name(row.constructor_ref),
            "title": r((final_pos[:, i] == 1).mean()), "top3": r((final_pos[:, i] <= 3).mean()),
            "mean": r(pts[:, i].mean(), 1),
            "p10": r(pct[0, i], 0), "p25": r(pct[1, i], 0), "p50": r(pct[2, i], 0), "p75": r(pct[3, i], 0), "p90": r(pct[4, i], 0),
            "positions": [r(x) for x in np.bincount(final_pos[:, i] - 1, minlength=n) / n_sims],
            "inputs": {"teamPrev": r(row.team_prev), "newTeam": bool(row.new_team), "driverEdge": r(row.driver_edge),
                       "rookie": bool(row.rookie), "strength": r(mu[i]), "prevStrength": r(prev) if prev is not None else None},
        })
    drivers_out.sort(key=lambda d: -d["mean"])

    team_pts = pd.DataFrame(pts, columns=field.constructor_ref).T.groupby(level=0).sum().T
    champ_team = team_pts.idxmax(axis=1).value_counts(normalize=True)
    constructors_out = sorted([
        {"id": ref, "name": team_name(ref), "title": r(champ_team.get(ref, 0.0)), "mean": r(team_pts[ref].mean(), 1),
         "p10": r(np.percentile(team_pts[ref], 10), 0), "p90": r(np.percentile(team_pts[ref], 90), 0),
         "teamPrev": r(field.loc[field.constructor_ref == ref, "team_prev"].iloc[0])}
        for ref in team_pts.columns], key=lambda t: -t["mean"])

    # the retirement trap, on the latest season
    latest = df[df.season == last]
    naive = fit_pl(season_races(df, last, finishers_only=False))
    trap = []
    for ref, g in latest.groupby("driver_ref"):
        if ref not in prev_strength.index:
            continue
        trap.append({"id": ref, "name": driver_name(ref)[0], "team": team_name(g.constructor_ref.mode()[0]),
                     "points": int(g.pts.sum()), "dnfs": int((g.finished == 0).sum()),
                     "strengthAllStarters": r(naive.get(ref)), "strength": r(prev_strength.strength[ref])})
    trap.sort(key=lambda t: -t["points"])

    # carry-over scatter: each team in each season (brand-new teams left out: they have no last year)
    carry = (pairs[~pairs.new_team].groupby(["season", "team"])
             .agg(lastYear=("team_prev", "first"), thisYear=("strength", "mean"), ref=("constructor_ref", lambda t: t.mode()[0]))
             .reset_index())
    carryover = [{"season": int(c.season), "team": team_name(c.ref), "lastYear": r(c.lastYear, 3), "thisYear": r(c.thisYear, 3)}
                 for c in carry.itertuples()]

    # 5. walk-forward backtest ----------------------------------------------------
    rows = []
    for y in range(2016, last + 1):
        if y not in pairs.season.values:
            continue
        beta_y, s_team, s_drv, _ = fit_carryover(pairs[pairs.season < y], strengths)
        bf = pairs[pairs.season == y].reset_index(drop=True)
        n_races = df[df.season == y].race_key.nunique()
        actual = bf.pts.to_numpy() * n_races / bf.races.to_numpy()     # missed races scaled to a full season
        champion = bf.pts.idxmax()
        for method, m, st, sd in [("repeat", (bf.team_prev + bf.driver_edge).to_numpy(), 0.0, 0.0),
                                  ("noSurprise", predict(beta_y, bf), 0.0, 0.0),
                                  ("model", predict(beta_y, bf), s_team, s_drv)]:
            sim = simulate_season(bf, m, st, sd, n_races, recent_dnf_rate(y), n_sims=4000)
            lo, hi = np.percentile(sim, [10, 90], axis=0)
            p_champ = (sim.argmax(axis=1) == champion).mean()
            rows.append({"season": y, "method": method, "champion": bf.driver_ref[champion],
                         "favourite": bf.driver_ref[sim.mean(axis=0).argmax()], "p": p_champ,
                         "logScore": np.log(max(p_champ, 1 / len(sim))),
                         "coverage": ((actual >= lo) & (actual <= hi)).mean(),
                         "orderCorr": spearmanr(sim.mean(axis=0), actual).statistic})
    bt = pd.DataFrame(rows)
    backtest = {
        "seasons": [{"season": int(y), "champion": driver_name(g.champion.iloc[0])[0],
                     **{m.method: {"p": r(m.p), "favourite": driver_name(m.favourite)[0]} for m in g.itertuples()}}
                    for y, g in bt.groupby("season")],
        "summary": {m: {k: r(v) for k, v in g[["p", "logScore", "coverage", "orderCorr"]].mean().items()}
                    for m, g in bt.groupby("method")},
    }

    out = {
        "season": target,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "dataThrough": {"season": last, "round": last_round, "roundsInSeason": rounds_in_season,
                        "race": last_race.race_name, "date": last_race.race_date},
        "settings": {"simulations": n_sims, "races": N_RACES, "dnfRate": r(dnf_rate), "points": POINTS.tolist(),
                     "lineupChanges": LINEUP_CHANGES},
        "model": {
            "coefficients": {k: r(v) for k, v in beta.items()},
            "sigmaTeam": r(sigma_team), "sigmaDriver": r(sigma_driver), "measurementNoise": r(noise),
            "spread": r(strengths[strengths.races >= 10].strength.std()),
            "trainingPairs": int(len(pairs)), "trainingSeasons": [int(pairs.season.min()), int(pairs.season.max())],
            "firstSeason": int(df.season.min()), "races": int(df.race_key.nunique()),
            "missingSeasons": [y for y in range(int(df.season.min()), last + 1) if y not in set(df.season)],
        },
        "drivers": drivers_out,
        "constructors": constructors_out,
        "retirementTrap": trap,
        "carryover": carryover,
        "backtest": backtest,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"{target} prediction from data through {last} round {last_round}/{rounds_in_season} "
          f"({n_sims:,} seasons x {N_RACES} races, {time.monotonic() - started:.0f}s)")
    for d in drivers_out[:6]:
        print(f"  {d['name']:<22} title {d['title']:>6.1%}  expected {d['mean']:>5.0f} pts  ({d['p10']:.0f}-{d['p90']:.0f})")
    s = backtest["summary"]["model"]
    print(f"backtest 2016-{bt.season.max()}: 80% range coverage {s['coverage']:.0%}, order correlation {s['orderCorr']:.2f}")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e3:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
