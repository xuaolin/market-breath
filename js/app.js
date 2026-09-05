import { fmt, scoreClass, signedPct, freshness } from "./calculations.js";
import {
  renderHistoryChart,
  resetHistoryZoom,
  findNearestSeriesPoint,
  extractFactorBreakdown,
  setSeriesVisibility,
  getSeriesVisibility,
  setIndicatorFocus,
  clearIndicatorFocus,
  getIndicatorFocus,
} from "./charts.js";

async function getJSON(path) {
  const r = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setScoreCard(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value == null ? "—" : Number(value).toFixed(1);
  el.className = `metric-value ${scoreClass(value)}`;
}


const UMSI_BINS = [
  [0, 15],
  [15, 30],
  [30, 45],
  [45, 65],
  [65, 80],
  [80, 90],
  [90, 101],
];

/** App state for brush-synced forward returns + indicator focus */
let fullHistory = null;
let lastRangePayload = null;
let syncForwardToWindow = false;
let activeDaily = null;

function zoneIndex(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  for (let i = 0; i < UMSI_BINS.length; i++) {
    const [lo, hi] = UMSI_BINS[i];
    if (n >= lo && n < hi) return i;
  }
  return null;
}
