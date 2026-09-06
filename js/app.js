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
  setHideLowQuality,
  getHideLowQuality,
} from "./charts.js";
import { getJSON, setText, setScoreCard, computeForwardTable } from "./app-lib.js";
import {
  renderTop,
  renderIndicators,
  renderForward,
  renderEvents,
  renderSources,
  updateRangeSummary,
  showEventDetail,
} from "./app-panels.js";

function chartCallbacks(history) {
  return {
    onRangeChange: updateRangeSummary,
    onEventClick: ({ event, nearest, factors }) =>
      showEventDetail({ event, nearest, factors, history }),
    onSeriesVisibilityChange: syncSeriesChipState,
    onIndicatorFocusChange: () => syncIndicatorRowHighlight(),
  };
}

function syncSeriesChipState(vis) {
  const state = vis || getSeriesVisibility();
  document.querySelectorAll("[data-series]").forEach((chip) => {
    const key = chip.dataset.series;
    const on = Boolean(state[key]);
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function bindSeriesChips() {
  document.querySelectorAll("[data-series]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const key = chip.dataset.series;
      if (!key) return;
      setSeriesVisibility(key);
    });
  });
  syncSeriesChipState();
}

function bindHideLowQChip() {
  const chip = document.getElementById("hideLowQChip");
  if (!chip) return;
  const sync = () => {
    const on = getHideLowQuality();
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  };
  sync();
  chip.addEventListener("click", () => {
    setHideLowQuality(!getHideLowQuality());
    sync();
  });
}

function bindForwardSyncToggle() {
  const toggle = document.getElementById("syncForwardToggle");
  if (!toggle) return;
  toggle.checked = false;
  syncForwardToWindow = false;
  toggle.addEventListener("change", () => {
    syncForwardToWindow = Boolean(toggle.checked);
    refreshForwardFromState();
  });
}

function bindRangeButtons(history) {
  document.querySelectorAll("[data-range]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-range]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderHistoryChart(history, btn.dataset.range, chartCallbacks(history));
    });
  });
}

function bindKeyboardHelp() {
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      const panel = document.getElementById("eventDetail");
      if (panel && !panel.hidden) {
        panel.hidden = true;
        panel.setAttribute("aria-hidden", "true");
        panel.innerHTML = "";
        return;
      }
      if (getIndicatorFocus()) {
        clearIndicatorFocus();
        syncIndicatorRowHighlight();
      }
    }
  });
}

async function main() {
  try {
    const [daily, intraday, history] = await Promise.all([
      getJSON("data/daily.json"),
      getJSON("data/intraday.json"),
      getJSON("data/history.json"),
    ]);

    fullHistory = history;
    activeDaily = daily;

    renderTop(daily, intraday, history);

    const deg = applyCredibilityUX(daily);

    if (daily.status === "ok" && deg.degraded) {
      const message = document.getElementById("systemMessage");
      const qualityPct = deg.qualityPct != null ? `${deg.qualityPct}%` : "n/a";
      const stressQ = daily.stress?.quality;
      const fragQ = daily.fragility?.quality;
      const extras = [];
      if (stressQ != null) extras.push(`stress quality ${Math.round(Number(stressQ) * 100)}%`);
      if (fragQ != null) extras.push(`fragility quality ${Math.round(Number(fragQ) * 100)}%`);
      const reasons = [];
      if (deg.lowQuality) reasons.push(`calculation quality is ${qualityPct}`);
      if (deg.anyScoreNull) reasons.push("one or more indicator scores are missing");
      if (deg.breadthUnavailable) reasons.push("market breadth is unavailable");
      message.textContent =
        `Data quality warning: ${reasons.join("; ")}` +
        (extras.length ? ` (${extras.join(", ")})` : "") +
        ". Model marked DEGRADED · 模型降级. Dashboard remains visible.";
      message.hidden = false;
    }

    renderIndicators(daily, deg);
    bindForwardSyncToggle();
    renderForward(history);
    renderEvents(history);
    renderSources(daily);
    bindSeriesChips();
    bindHideLowQChip();
    renderHistoryChart(history, "5Y", chartCallbacks(history));
    bindRangeButtons(history);
    bindKeyboardHelp();

    if (daily.status !== "ok") {
      const message = document.getElementById("systemMessage");
      message.textContent = "Run the GitHub Action once to populate live market data.";
      message.hidden = false;
    }
  } catch (err) {
    console.error(err);
    const msg = document.getElementById("systemMessage");
    msg.textContent = `Dashboard data could not be loaded: ${err.message}`;
    msg.hidden = false;
  }
}

main();
