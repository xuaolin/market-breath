UMSI V2 FIX PACKAGE

Replace these exact repository files:

scripts/common.py
scripts/build_history.py
scripts/calculate_umsi.py
js/charts.js
js/app.js
css/style.css

Then commit to main and run:
Actions -> Update UMSI Data -> Run workflow

What V2 fixes:
- Historical chart now uses numeric timestamps, so Chart.js time scale renders correctly.
- Current UMSI point and historical event markers/labels added.
- Tooltip shows UMSI, Stress, Fragility, S&P 500 and model quality.
- Rolling percentile no longer produces a score when the current raw observation is missing.
- FRED VIX/VIX3M/HY OAS can be carried forward for up to 3 market rows, but their true source_date is preserved.
- Cboe current put/call is requested for the actual latest S&P 500 trading date.
- Official Cboe equity put/call 2006-2019 archive is used as a reference history.
- First V2 run bootstraps ~30 recent Cboe daily put/call observations.
- Sparse Cboe/AAII percentiles are based on actual observations, not duplicated forward-filled daily rows.
- Indicator contribution uses effective re-normalized weight when an input is unavailable.
- UMSI card is visually emphasized.

The first V2 GitHub Action may take longer than normal because it bootstraps Cboe data.
Later runs should return to normal speed.
