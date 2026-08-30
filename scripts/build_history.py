from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    DATA_DIR,
    fetch_aaii_recent,
    fetch_cboe_equity_put_call,
    fetch_fred_series,
    fetch_stooq,
    fetch_yahoo_history,
    merge_records,
    now_iso,
    read_json,
    write_json,
)

BASE_WEIGHTS = {
    "term_score": 0.20,
    "credit_score": 0.20,
    "breadth_score": 0.20,
    "vix_score": 0.15,
    "put_call_score": 0.10,
    "drawdown_score": 0.10,
    "aaii_score": 0.05,
}

REQUIRED_COLUMNS = [
    "vix",
    "vix3m",
    "hy_oas",
    "spy",
    "rsp",
    "sp500",
    "put_call",
    "aaii_spread",
]


def rolling_percentile(
    s: pd.Series,
    window: int = 1260,
    min_periods: int = 252,
) -> pd.Series:
    def pct(a: np.ndarray) -> float:
        a = a[np.isfinite(a)]
        if len(a) == 0:
            return np.nan
        return float(np.mean(a <= a[-1]) * 100.0)

    return s.rolling(window=window, min_periods=min_periods).apply(pct, raw=True)


def weighted_composite(
    df: pd.DataFrame,
    weights: dict[str, float],
) -> tuple[pd.Series, pd.Series]:
    numerator = pd.Series(0.0, index=df.index, dtype=float)
    denominator = pd.Series(0.0, index=df.index, dtype=float)

    for c, w in weights.items():
        if c not in df.columns:
            continue
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


def add_price_series(
    series: dict[str, pd.Series],
    name: str,
    yahoo_symbol: str,
    stooq_symbol: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> None:
    """Yahoo first; Stooq second. Never raises for an individual source."""
    try:
        y = fetch_yahoo_history(yahoo_symbol, start, end)
        if not y.empty and "Close" in y:
            series[name] = y["Close"].rename(name)
            print(f"Yahoo {yahoo_symbol}: {len(y):,} rows")
            return
        print(f"WARN Yahoo {yahoo_symbol} returned no daily rows")
    except Exception as e:
        print(f"WARN Yahoo {yahoo_symbol} failed: {e}")

    try:
        s = fetch_stooq(stooq_symbol, start, end)
        if not s.empty and "Close" in s:
            series[name] = s["Close"].rename(name)
            print(f"Stooq {stooq_symbol}: {len(s):,} rows")
            return
        print(f"WARN Stooq {stooq_symbol} returned no daily rows")
    except Exception as e:
        print(f"WARN Stooq {stooq_symbol} failed: {e}")


def ensure_columns(df: pd.DataFrame, names: list[str]) -> pd.DataFrame:
    for name in names:
        if name not in df.columns:
            df[name] = np.nan
    return df


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    src = update_slow_sources()

    csv_path = DATA_DIR / "history.csv"
    if csv_path.exists():
        old = (
            pd.read_csv(csv_path, parse_dates=["date"])
            .set_index("date")
            .sort_index()
        )
        start = old.index.max() - pd.Timedelta(days=60)
    else:
        old = pd.DataFrame()
        start = pd.Timestamp("2007-12-04")

    end = pd.Timestamp.utcnow().tz_localize(None).normalize()

    series: dict[str, pd.Series] = {}

    for fred_id, name in [
        ("VIXCLS", "vix"),
        ("VXVCLS", "vix3m"),
        ("BAMLH0A0HYM2", "hy_oas"),
    ]:
        try:
            s = fetch_fred_series(fred_id)
            s = s.loc[(s.index >= start) & (s.index <= end)]
            if not s.empty:
                series[name] = s.rename(name)
                print(f"FRED {fred_id}: {len(s):,} rows")
            else:
                print(f"WARN FRED {fred_id} returned no rows in requested window")
        except Exception as e:
            print(f"WARN FRED {fred_id} failed: {e}")

    add_price_series(series, "sp500", "^GSPC", "^spx", start, end)
    add_price_series(series, "spy", "SPY", "spy.us", start, end)
    add_price_series(series, "rsp", "RSP", "rsp.us", start, end)

    if not series and old.empty:
        raise RuntimeError("No historical market series could be downloaded and no prior history exists")

    if series:
        fresh = pd.concat(series.values(), axis=1)
        fresh.columns = list(series.keys())
    else:
        fresh = pd.DataFrame(index=old.index.copy())

    if old.empty:
        combined = fresh.sort_index()
    else:
        combined = fresh.combine_first(old).sort_index()

    combined = ensure_columns(combined, REQUIRED_COLUMNS)

    if combined["sp500"].notna().sum() == 0 and combined["spy"].notna().sum() > 0:
        combined["sp500"] = combined["spy"]
        print("WARN ^GSPC unavailable; using SPY as S&P 500 price-path proxy")

    if combined["spy"].notna().sum() == 0 and combined["sp500"].notna().sum() > 0:
        combined["spy"] = combined["sp500"]
        print("WARN SPY unavailable; using S&P 500 index as temporary SPY proxy")

    if combined["sp500"].notna().sum() == 0:
        raise RuntimeError(
            "S&P 500 history is unavailable from Yahoo, Stooq, and prior saved history"
        )

    if src.get("put_call"):
        pc = pd.DataFrame(src["put_call"])
        pc["date"] = pd.to_datetime(pc["date"], errors="coerce")
        pc = (
            pc.dropna(subset=["date"])
            .set_index("date")["value"]
            .apply(pd.to_numeric, errors="coerce")
            .sort_index()
        )
        combined["put_call"] = pc.reindex(combined.index).combine_first(
            combined["put_call"]
        )
        combined["put_call"] = combined["put_call"].ffill(limit=5)

    if src.get("aaii"):
        aa = pd.DataFrame(src["aaii"])
        aa["date"] = pd.to_datetime(aa["date"], errors="coerce")
        aa = (
            aa.dropna(subset=["date"])
            .set_index("date")["spread"]
            .apply(pd.to_numeric, errors="coerce")
            .sort_index()
        )
        combined["aaii_spread"] = aa.reindex(combined.index).combine_first(
            combined["aaii_spread"]
        )
        combined["aaii_spread"] = combined["aaii_spread"].ffill(limit=10)

    combined["term_ratio"] = combined["vix"] / combined["vix3m"]

    if combined["rsp"].notna().any() and combined["spy"].notna().any():
        rel = combined["rsp"] / combined["spy"]
        combined["breadth_raw"] = (
            0.60 * rel.pct_change(63, fill_method=None)
            + 0.40 * rel.pct_change(252, fill_method=None)
        )
        combined["concentration_raw"] = -combined["breadth_raw"]
    else:
        combined["breadth_raw"] = np.nan
        combined["concentration_raw"] = np.nan

    combined["drawdown_52w"] = (
        combined["sp500"]
        / combined["sp500"].rolling(252, min_periods=60).max()
        - 1.0
    )
    combined["stretch_200d"] = (
        combined["sp500"]
        / combined["sp500"].rolling(200, min_periods=120).mean()
        - 1.0
    )

    combined["term_pct"] = rolling_percentile(combined["term_ratio"])
    combined["term_score"] = 100.0 - combined["term_pct"]

    combined["credit_pct"] = rolling_percentile(combined["hy_oas"])
    combined["credit_score"] = 100.0 - combined["credit_pct"]

    combined["breadth_pct"] = rolling_percentile(combined["breadth_raw"])
    combined["breadth_score"] = combined["breadth_pct"]

    combined["vix_pct"] = rolling_percentile(combined["vix"])
    combined["vix_score"] = 100.0 - combined["vix_pct"]

    combined["put_call_pct"] = rolling_percentile(
        combined["put_call"],
        min_periods=20,
    )
    combined["put_call_score"] = 100.0 - combined["put_call_pct"]

    combined["drawdown_pct"] = rolling_percentile(combined["drawdown_52w"])
    combined["drawdown_score"] = combined["drawdown_pct"]

    combined["aaii_pct"] = rolling_percentile(
        combined["aaii_spread"],
        min_periods=20,
    )
    combined["aaii_score"] = combined["aaii_pct"]

    combined["umsi"], combined["calculation_quality"] = weighted_composite(
        combined,
        BASE_WEIGHTS,
    )

    stress_components = pd.DataFrame(index=combined.index)
    stress_components["term_stress"] = 100.0 - combined["term_score"]
    stress_components["credit_stress"] = 100.0 - combined["credit_score"]
    stress_components["vix_stress"] = 100.0 - combined["vix_score"]
    stress_components["drawdown_stress"] = 100.0 - combined["drawdown_score"]

    combined["stress"], combined["stress_quality"] = weighted_composite(
        stress_components,
        {
            "term_stress": 0.25,
            "credit_stress": 0.25,
            "vix_stress": 0.30,
            "drawdown_stress": 0.20,
        },
    )

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

    combined = combined.loc[combined["sp500"].notna()].copy()
    if combined.empty:
        raise RuntimeError("History contains no valid S&P 500 observations")

    valid_umsi = combined["umsi"].notna().sum()
    if valid_umsi == 0:
        raise RuntimeError(
            "Market history was downloaded, but no UMSI values could be calculated. "
            "Check VIX/VIX3M/FRED availability."
        )

    combined.index.name = "date"
    combined.reset_index().to_csv(csv_path, index=False)

    latest_quality = combined.loc[combined["umsi"].notna(), "calculation_quality"].iloc[-1]
    print(
        f"History saved: {len(combined):,} rows, "
        f"{combined.index.min().date()} -> {combined.index.max().date()}, "
        f"latest calculation quality={latest_quality:.0%}"
    )


if __name__ == "__main__":
    main()
