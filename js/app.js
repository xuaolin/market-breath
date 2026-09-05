import { fmt, scoreClass, signedPct, freshness } from "./calculations.js";
import {
  renderHistoryChart,
  resetHistoryZoom,
  findNearestSeriesPoint,
  extractFactorBreakdown,
} from "./charts.js";

async function getJSON(path) {
  const r = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
