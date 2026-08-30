from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (DATA_DIR, fetch_aaii_recent, fetch_cboe_equity_put_call, fetch_fred_series,
                    fetch_stooq, merge_records, now_iso, read_json, write_json)

BASE_WEIGHTS = {
    "term_score": 0.20,
    "credit_score": 0.20,
    "breadth_score": 0.20,
    "vix_score": 0.15,
    "put_call_score": 0.10,
    "drawdown_score": 0.10,
    "aaii_score": 0.05,
}


def rolling_percentile(s: pd.Series, window: int = 1260, min_periods: int = 252) -> pd.Series:
    def pct(a: np.ndarray) -> float:
        a = a[np.isfinite(a)]
        if len(a) == 0:
            return np.nan
        return float(np.mean(a <= a[-1]) * 100.0)
    return s.rolling(window=window, min_periods=min_periods).apply(pct, raw=True)


def weighted_composite(df: pd.DataFrame, weights: dict[str, float]) -> tuple[pd.Series, pd.Series]:
    cols = list(weights)
    numerator = pd.Series(0.0, index=df.index)
    denominator = pd.Series(0.0, index=df.index)
    for c, w in weights.items():
        mask = df[c].notna()
        numerator = numerator.add(df[c].fillna(0) * w, fill_value=0)
        denominator = denominator.add(mask.astype(float) * w, fill_value=0)
    score = numerator.div(denominator.where(denominator > 0))
    return score, denominator


def update_slow_sources() -> dict:
    path = DATA_DIR / "source_history.json"
    src = read_json(path, {"put_call": [], "aaii": []})
    src.setdefault("put_call", [])
    src.setdefault("aaii", [])

    try:
        pc = fetch_cboe_equity_put_call()
        src["put_call"] = merge_records(src["put_call"], [pc])
        print(f"Cboe put/call updated: {pc['value']}")
    except Exception as e:
        print(f"WARN Cboe put/call fetch failed; keeping old values: {e}")

    try:
        recent = fetch_aaii_recent()
        src["aaii"] = merge_records(src["aaii"], recent)
        print(f"AAII updated: {len(recent)} recent rows")
    except Exception as e:
        print(f"WARN AAII fetch failed; keeping old values: {e}")

    src["updated_at"] = now_iso()
    write_json(path, src)
    return src


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    src = update_slow_sources()

    csv_path = DATA_DIR / "history.csv"
    if csv_path.exists():
        old = pd.read_csv(csv_path, parse_dates=["date"]).set_index("date").sort_index()
        start = old.index.max() - pd.Timedelta(days=45)
    else:
        old = pd.DataFrame()
        start = pd.Timestamp("2007-12-04")
    end = pd.Timestamp.utcnow().tz_localize(None).normalize()

    series = {}
    for fred_id, name in [("VIXCLS", "vix"), ("VXVCLS", "vix3m"), ("BAMLH0A0HYM2", "hy_oas")]:
        try:
            s = fetch_fred_series(fred_id)
            series[name] = s.loc[s.index >= start]
        except Exception as e:
            print(f"WARN FRED {fred_id} failed: {e}")

    # Stooq supplies long price histories without an API key.
    try:
        spy = fetch_stooq("spy.us", start, end)
        if not spy.empty:
            series["spy"] = spy["Close"]
    except Exception as e:
        print(f"WARN Stooq SPY failed: {e}")

    try:
        rsp = fetch_stooq("rsp.us", start, end)
        if not rsp.empty:
            series["rsp"] = rsp["Close"]
    except Exception as e:
        print(f"WARN Stooq RSP failed: {e}")

    try:
        spx = fetch_stooq("^spx", start, end)
        if not spx.empty:
            series["sp500"] = spx["Close"]
    except Exception as e:
        print(f"WARN Stooq SPX failed: {e}")

    if not series:
        raise RuntimeError("No market series could be downloaded")

    fresh = pd.concat(series.values(), axis=1)
    fresh.columns = list(series.keys())
    if "sp500" not in fresh.columns and "spy" in fresh.columns:
        fresh["sp500"] = fresh["spy"]

    # Prefer newly fetched non-null values, but retain old values for any source that failed.
    # This is important when one provider is temporarily unavailable during an incremental update.
    combined = fresh.combine_first(old).sort_index()

    # Slow-source histories are aligned to trading dates. Put/call is daily; AAII is weekly.
    if src.get("put_call"):
        pc = pd.DataFrame(src["put_call"])
        pc["date"] = pd.to_datetime(pc["date"])
        pc = pc.set_index("date")["value"].astype(float).sort_index()
        combined["put_call"] = pc.reindex(combined.index).ffill(limit=5)
    elif "put_call" not in combined:
        combined["put_call"] = np.nan

    if src.get("aaii"):
        aa = pd.DataFrame(src["aaii"])
        aa["date"] = pd.to_datetime(aa["date"])
        aa = aa.set_index("date")["spread"].astype(float).sort_index()
        combined["aaii_spread"] = aa.reindex(combined.index).ffill(limit=10)
    elif "aaii_spread" not in combined:
        combined["aaii_spread"] = np.nan

    # Derived raw indicators.
    combined["term_ratio"] = combined["vix"] / combined["vix3m"]
    if {"rsp", "spy"}.issubset(combined.columns):
        rel = combined["rsp"] / combined["spy"]
        combined["breadth_raw"] = 0.60 * rel.pct_change(63) + 0.40 * rel.pct_change(252)
        combined["concentration_raw"] = -combined["breadth_raw"]
    else:
        combined["breadth_raw"] = np.nan
        combined["concentration_raw"] = np.nan

    combined["drawdown_52w"] = combined["sp500"] / combined["sp500"].rolling(252, min_periods=60).max() - 1.0
    combined["stretch_200d"] = combined["sp500"] / combined["sp500"].rolling(200, min_periods=120).mean() - 1.0

    # Percentile-based sentiment scores, where higher = more risk-on / optimistic.
    combined["term_pct"] = rolling_percentile(combined["term_ratio"])
    combined["term_score"] = 100.0 - combined["term_pct"]

    combined["credit_pct"] = rolling_percentile(combined["hy_oas"])
    combined["credit_score"] = 100.0 - combined["credit_pct"]

    combined["breadth_pct"] = rolling_percentile(combined["breadth_raw"])
    combined["breadth_score"] = combined["breadth_pct"]

    combined["vix_pct"] = rolling_percentile(combined["vix"])
    combined["vix_score"] = 100.0 - combined["vix_pct"]

    combined["put_call_pct"] = rolling_percentile(combined["put_call"], min_periods=20)
    combined["put_call_score"] = 100.0 - combined["put_call_pct"]

    combined["drawdown_pct"] = rolling_percentile(combined["drawdown_52w"])
    combined["drawdown_score"] = combined["drawdown_pct"]

    combined["aaii_pct"] = rolling_percentile(combined["aaii_spread"], min_periods=20)
    combined["aaii_score"] = combined["aaii_pct"]

    combined["umsi"], combined["calculation_quality"] = weighted_composite(combined, BASE_WEIGHTS)

    # Stress: higher = more financial stress.
    stress_components = pd.DataFrame(index=combined.index)
    stress_components["term_stress"] = 100.0 - combined["term_score"]
    stress_components["credit_stress"] = 100.0 - combined["credit_score"]
    stress_components["vix_stress"] = 100.0 - combined["vix_score"]
    stress_components["drawdown_stress"] = 100.0 - combined["drawdown_score"]
    combined["stress"], combined["stress_quality"] = weighted_composite(
        stress_components,
        {"term_stress": 0.25, "credit_stress": 0.25, "vix_stress": 0.30, "drawdown_stress": 0.20},
    )

    # Fragility: higher = a stronger-looking market that is more vulnerable to reversal.
    concentration_risk = rolling_percentile(combined["concentration_raw"])
    stretch_risk = rolling_percentile(combined["stretch_200d"])
    frag = pd.DataFrame(index=combined.index)
    frag["low_vol_complacency"] = combined["vix_score"]
    frag["curve_complacency"] = combined["term_score"]
    frag["narrow_breadth"] = 100.0 - combined["breadth_score"]
    frag["aaii_optimism"] = combined["aaii_score"]
    frag["low_put_call"] = combined["put_call_score"]
    frag["concentration"] = concentration_risk
    frag["price_stretch"] = stretch_risk
    combined["fragility"], combined["fragility_quality"] = weighted_composite(
        frag,
        {
            "low_vol_complacency": 0.15,
            "curve_complacency": 0.10,
            "narrow_breadth": 0.25,
            "aaii_optimism": 0.10,
            "low_put_call": 0.10,
            "concentration": 0.15,
            "price_stretch": 0.15,
        },
    )

    # Keep rows where at least the core market data exists.
    combined = combined.loc[combined["sp500"].notna()].copy()
    combined.index.name = "date"
    combined.reset_index().to_csv(csv_path, index=False)
    print(f"History saved: {len(combined):,} rows, {combined.index.min().date()} -> {combined.index.max().date()}")


if __name__ == "__main__":
    main()
