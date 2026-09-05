let historyChart;
let chartCallbacks = {};
let activeHistory = null;
let activeRange = "5Y";
let pointerDown = null;
let indicatorFocus = null; // { key, label, scoreKey } | null

/** Series visibility: UMSI on by default; Stress/Fragility/SPX start OFF. */
let seriesVisibility = {
  UMSI: true,
  Stress: false,
  Fragility: false,
  SPX: false,
};

const SERIES_META = {
  UMSI: { borderColor: "#9ee7ff", backgroundColor: "rgba(158,231,255,.03)", yKey: "umsi", yAxisID: "y" },
  Stress: { borderColor: "#ff8c42", backgroundColor: "rgba(255,140,66,.03)", yKey: "stress", yAxisID: "y" },
  Fragility: { borderColor: "#a55eea", backgroundColor: "rgba(165,94,234,.03)", yKey: "fragility", yAxisID: "y" },
  SPX: { borderColor: "rgba(120,180,140,.85)", backgroundColor: "rgba(120,180,140,.04)", yKey: "sp500", yAxisID: "y1" },
};

const rangeDays = {
  "1Y": 365,
  "3Y": 365 * 3,
  "5Y": 365 * 5,
  "10Y": 365 * 10,
  "MAX": Infinity,
};

function toTs(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

function filterRange(series, range) {
  if (!series?.length) return [];
  if (range === "MAX") return series;
  const days = rangeDays[range] || 365;
  const maxDate = toTs(series.at(-1).date);
  const minDate = maxDate - days * 86400000;
  return series.filter(p => toTs(p.date) >= minDate);
}


const FACTOR_KEYS = [
  "term", "credit", "breadth", "vix", "put_call", "aaii", "drawdown",
  "factors", "indicators", "scores", "contributions",
];

function tsToDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function filterSeriesByWindow(series, minTs, maxTs) {
  if (!series?.length) return [];
  const lo = Math.min(minTs, maxTs);
  const hi = Math.max(minTs, maxTs);
  return series.filter((p) => {
    const t = toTs(p.date);
    return t >= lo && t <= hi;
  });
}

export function summarizeWindow(points) {
  const nums = (key) =>
    points.map((p) => p[key]).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);

  function stats(arr) {
    if (!arr.length) return null;
    const sum = arr.reduce((a, b) => a + b, 0);
    return { avg: sum / arr.length, min: Math.min(...arr), max: Math.max(...arr), n: arr.length };
  }

  const umsi = stats(nums("umsi"));
  const stress = stats(nums("stress"));
  const fragility = stats(nums("fragility"));

  let spxChange = null;
  const withSpx = points.filter((p) => p.sp500 != null && Number.isFinite(Number(p.sp500)));
  if (withSpx.length >= 2) {
    const first = Number(withSpx[0].sp500);
    const last = Number(withSpx.at(-1).sp500);
    if (first) spxChange = ((last - first) / first) * 100;
  }

  return {
    count: points.length,
    start: points[0]?.date || null,
    end: points.at(-1)?.date || null,
    umsi,
    stress,
    fragility,
    spxChange,
  };
}

export function findNearestSeriesPoint(series, date) {
  if (!series?.length || !date) return null;
  const target = toTs(date);
  let best = series[0];
  let bestDist = Math.abs(toTs(best.date) - target);
  for (let i = 1; i < series.length; i++) {
    const d = Math.abs(toTs(series[i].date) - target);
    if (d < bestDist) {
      best = series[i];
      bestDist = d;
    }
  }
  return best;
}

export function extractFactorBreakdown(point) {
  if (!point) return [];
  const out = [];
  for (const key of FACTOR_KEYS) {
    const val = point[key];
    if (val == null) continue;
    if (typeof val === "number" && Number.isFinite(val)) {
      out.push({ key, label: key, value: val });
    } else if (typeof val === "object" && !Array.isArray(val)) {
      Object.entries(val).forEach(([k, v]) => {
        if (v == null) return;
        if (typeof v === "number" && Number.isFinite(v)) {
          out.push({ key: `${key}.${k}`, label: k, value: v });
        } else if (v && typeof v === "object" && (v.score != null || v.contribution != null)) {
          out.push({
            key: `${key}.${k}`,
            label: v.label || k,
            value: v.score ?? v.contribution,
            score: v.score,
            contribution: v.contribution,
            weight: v.weight,
          });
        }
      });
    }
  }
  Object.entries(point).forEach(([k, v]) => {
    if (["date", "umsi", "stress", "fragility", "sp500", "quality", "event"].includes(k)) return;
    if (FACTOR_KEYS.includes(k)) return;
    if (typeof v === "number" && Number.isFinite(v) && /(score|contrib|factor)/i.test(k)) {
      out.push({ key: k, label: k, value: v });
    }
  });
  return out;
}

/** Pull a numeric factor score for indicator key from a history point, if present. */
export function extractFactorScore(point, indicatorKey) {
  if (!point || !indicatorKey) return null;
  const key = String(indicatorKey);
  const candidates = [
    point[key],
    point[`${key}_score`],
    point.scores?.[key],
    point.factors?.[key],
    point.indicators?.[key],
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "object") {
      const v = c.score ?? c.value;
      if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
  }
  const breakdown = extractFactorBreakdown(point);
  const hit = breakdown.find(
    (f) =>
      f.key === key ||
      f.key.endsWith(`.${key}`) ||
      f.label === key ||
      String(f.label || "").toLowerCase().includes(key.replace(/_/g, " "))
  );
  return hit?.score ?? hit?.value ?? null;
}

/** True if enough history points expose per-factor scores for this indicator. */
export function seriesHasFactorScores(series, indicatorKey) {
  if (!series?.length || !indicatorKey) return false;
  let hits = 0;
  const sample = series.length > 80 ? series.filter((_, i) => i % Math.ceil(series.length / 80) === 0) : series;
  for (const p of sample) {
    if (extractFactorScore(p, indicatorKey) != null) hits += 1;
    if (hits >= 8) return true;
  }
  return false;
}

function quartileBounds(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (xs.length < 8) return null;
  const q = (p) => {
    const idx = (xs.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return xs[lo];
    return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
  };
  return { q25: q(0.25), q75: q(0.75) };
}

function getChartXBounds(chart) {
  const scale = chart.scales?.x;
  if (!scale) return null;
  return { min: scale.min, max: scale.max };
}

function emitRangeChange(chart) {
  if (!activeHistory?.series?.length || typeof chartCallbacks.onRangeChange !== "function") return;
  const bounds = getChartXBounds(chart);
  if (!bounds) return;
  const windowed = filterSeriesByWindow(activeHistory.series, bounds.min, bounds.max);
  chartCallbacks.onRangeChange({
    minTs: bounds.min,
    maxTs: bounds.max,
    start: tsToDate(bounds.min),
    end: tsToDate(bounds.max),
    summary: summarizeWindow(windowed),
    points: windowed,
    preset: activeRange,
  });
}

function emitVisibilityChange() {
  if (typeof chartCallbacks.onSeriesVisibilityChange === "function") {
    chartCallbacks.onSeriesVisibilityChange({ ...seriesVisibility });
  }
}

export function getSeriesVisibility() {
  return { ...seriesVisibility };
}

/**
 * Toggle or set visibility for UMSI / Stress / Fragility / SPX line datasets.
 * @param {string} name - "UMSI" | "Stress" | "Fragility" | "SPX"
 * @param {boolean} [visible] - if omitted, toggles
 */
export function setSeriesVisibility(name, visible) {
  if (!(name in seriesVisibility)) return seriesVisibility;
  seriesVisibility[name] = visible == null ? !seriesVisibility[name] : Boolean(visible);

  if (historyChart) {
    historyChart.data.datasets.forEach((ds) => {
      if (ds.label === name && ds._seriesKey) {
        ds.hidden = !seriesVisibility[name];
      }
    });
    // Show/hide right axis with SPX
    if (name === "SPX" && historyChart.options?.scales?.y1) {
      historyChart.options.scales.y1.display = seriesVisibility.SPX;
    }
    historyChart.update("none");
  }

  emitVisibilityChange();
  syncSeriesChips();
  return { ...seriesVisibility };
}

function syncSeriesChips() {
  document.querySelectorAll("[data-series]").forEach((chip) => {
    const key = chip.dataset.series;
    const on = Boolean(seriesVisibility[key]);
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

export function getHistoryChart() {
  return historyChart;
}

export function getIndicatorFocus() {
  return indicatorFocus ? { ...indicatorFocus } : null;
}

export function clearIndicatorFocus() {
  indicatorFocus = null;
  applyIndicatorFocusVisuals();
  updateFocusBanner(null);
  if (typeof chartCallbacks.onIndicatorFocusChange === "function") {
    chartCallbacks.onIndicatorFocusChange(null);
  }
}

/**
 * Emphasize an indicator on the history chart.
 * If per-factor history exists, bump extreme quartile days; else banner-only.
 * @returns {{ mode: "factor-extremes"|"banner", count?: number }|null}
 */
export function setIndicatorFocus(focus) {
  if (!focus?.key) {
    clearIndicatorFocus();
    return null;
  }
  // Toggle off if same key re-selected
  if (indicatorFocus?.key === focus.key) {
    clearIndicatorFocus();
    return null;
  }

  const series = activeHistory?.series || [];
  const hasFactors = seriesHasFactorScores(series, focus.key);
  indicatorFocus = {
    key: focus.key,
    label: focus.label || focus.key,
    score: focus.score,
    percentile: focus.percentile,
    status: focus.status,
    hasFactors,
  };

  let result = { mode: "banner" };
  if (hasFactors && historyChart) {
    const filtered = historyChart.data?.datasets?.find((d) => d._seriesKey === "UMSI")?.data || [];
    const scores = filtered.map((p) => extractFactorScore(p.raw || p, focus.key));
    const bounds = quartileBounds(scores);
    const extremePts = [];
    if (bounds) {
      filtered.forEach((p, i) => {
        const s = scores[i];
        if (s == null) return;
        if (s <= bounds.q25 || s >= bounds.q75) {
          extremePts.push({
            x: p.x,
            y: p.y,
            date: p.date,
            umsi: p.umsi,
            stress: p.stress,
            fragility: p.fragility,
            sp500: p.sp500,
            quality: p.quality,
            factorScore: s,
            raw: p.raw || p,
          });
        }
      });
    }
    applyIndicatorFocusVisuals(extremePts);
    result = { mode: "factor-extremes", count: extremePts.length };
  } else {
    applyIndicatorFocusVisuals([]);
  }

  updateFocusBanner(indicatorFocus);
  if (typeof chartCallbacks.onIndicatorFocusChange === "function") {
    chartCallbacks.onIndicatorFocusChange(indicatorFocus);
  }
  return result;
}

function applyIndicatorFocusVisuals(extremePts = []) {
  if (!historyChart) return;
  const dsIdx = historyChart.data.datasets.findIndex((d) => d._focusOverlay);
  if (dsIdx >= 0) historyChart.data.datasets.splice(dsIdx, 1);

  if (extremePts.length) {
    historyChart.data.datasets.push({
      type: "scatter",
      label: "Factor extremes",
      _focusOverlay: true,
      data: extremePts,
      pointRadius: 3.5,
      pointHoverRadius: 6,
      borderColor: "rgba(158,231,255,.9)",
      borderWidth: 1,
      backgroundColor: "rgba(245,196,81,.75)",
      order: 0,
    });
  }

  // Subtle pointRadius bump on UMSI for focused state (flash feel without fabricating)
  historyChart.data.datasets.forEach((ds) => {
    if (ds._seriesKey === "UMSI") {
      ds.pointRadius = indicatorFocus ? 1.2 : 0;
      ds.pointBackgroundColor = indicatorFocus ? "rgba(158,231,255,.35)" : undefined;
    }
  });

  historyChart.update("none");
}

function updateFocusBanner(focus) {
  const el = document.getElementById("chartFocusBanner");
  if (!el) return;
  if (!focus) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const bits = [];
  if (focus.score != null && Number.isFinite(Number(focus.score))) bits.push(`score ${Number(focus.score).toFixed(1)}`);
  if (focus.percentile != null && Number.isFinite(Number(focus.percentile))) bits.push(`%ile ${Number(focus.percentile).toFixed(1)}`);
  if (focus.status) bits.push(focus.status);
  const modeNote = focus.hasFactors
    ? " · yellow markers = historical factor extremes (Q1/Q4)"
    : " · no per-factor history in series; current daily snapshot only";
  el.hidden = false;
  el.innerHTML = `
    <div class="focus-banner-inner">
      <span class="focus-banner-label">Focus:</span>
      <span class="focus-banner-name">${focus.label}</span>
      <span class="focus-banner-meta">${bits.join(" · ")}${modeNote}</span>
      <button type="button" class="ghost-btn focus-clear-btn" id="clearIndicatorFocusBtn" aria-label="Clear indicator focus">Clear</button>
    </div>
  `;
  document.getElementById("clearIndicatorFocusBtn")?.addEventListener("click", () => clearIndicatorFocus());
}

export function resetHistoryZoom() {
  if (!historyChart) return;
  if (typeof historyChart.resetZoom === "function") historyChart.resetZoom();
  emitRangeChange(historyChart);
}

function shortEventLabel(name) {
  return name
    .replace("2009 ", "")
    .replace("2018 ", "")
    .replace("2020 ", "")
    .replace("2022 ", "")
    .replace("2025 ", "")
    .replace("Bear Market Low", "Bear Low")
    .replace("Q4 Selloff", "Q4 Selloff");
}

function buildLinePoints(filtered, yKey) {
  return filtered.map((p) => ({
    x: toTs(p.date),
    y: p[yKey],
    date: p.date,
    umsi: p.umsi,
    stress: p.stress,
    fragility: p.fragility,
    sp500: p.sp500,
    quality: p.quality,
    raw: p,
  }));
}

function firePointDetail(rawPoint, history) {
  if (!rawPoint || typeof chartCallbacks.onEventClick !== "function") return;
  const date = rawPoint.date;
  const nearest = findNearestSeriesPoint(history.series, date);
  const factors = extractFactorBreakdown(nearest);
  const isNamedEvent = Boolean(rawPoint.event && rawPoint.event !== "UMSI snapshot");
  const event = isNamedEvent
    ? (rawPoint.raw || rawPoint)
    : {
        date,
        event: "UMSI snapshot",
        umsi: nearest?.umsi ?? rawPoint.umsi ?? rawPoint.y,
        stress: nearest?.stress ?? rawPoint.stress,
        fragility: nearest?.fragility ?? rawPoint.fragility,
      };
  chartCallbacks.onEventClick({ event, nearest, factors });
}

export function renderHistoryChart(history, range = "5Y", callbacks = {}) {
  const canvas = document.getElementById("historyChart");
  if (!canvas || !history?.series?.length) return;

  chartCallbacks = callbacks || {};
  activeHistory = history;
  activeRange = range;

  const filtered = filterRange(history.series, range);
  if (!filtered.length) return;

  const filteredStart = toTs(filtered[0].date);
  const filteredEnd = toTs(filtered.at(-1).date);
  const visibleEvents = (history.events || []).filter(e => {
    const x = toTs(e.date);
    return x >= filteredStart && x <= filteredEnd;
  });

  const umsiData = buildLinePoints(filtered, "umsi");
  const stressData = buildLinePoints(filtered, "stress");
  const fragilityData = buildLinePoints(filtered, "fragility");
  const spxData = buildLinePoints(filtered, "sp500");

  const eventPoints = visibleEvents.map(e => ({
    x: toTs(e.date),
    y: e.umsi,
    date: e.date,
    event: e.event,
    stress: e.stress,
    fragility: e.fragility,
    return_1m: e.return_1m,
    return_3m: e.return_3m,
    return_6m: e.return_6m,
    raw: e,
  }));

  const latest = umsiData.at(-1);

  const annotations = {
    fearZone: {
      type: "box",
      yMin: 0,
      yMax: 15,
      backgroundColor: "rgba(255, 71, 87, .08)",
      borderWidth: 0,
    },
    complacencyZone: {
      type: "box",
      yMin: 90,
      yMax: 100,
      backgroundColor: "rgba(165, 94, 234, .10)",
      borderWidth: 0,
    },
    fearLine: {
      type: "line",
      yMin: 15,
      yMax: 15,
      borderColor: "rgba(255,71,87,.45)",
      borderDash: [5, 5],
      borderWidth: 1,
    },
    complacencyLine: {
      type: "line",
      yMin: 90,
      yMax: 90,
      borderColor: "rgba(165,94,234,.55)",
      borderDash: [5, 5],
      borderWidth: 1,
    },
    currentLine: {
      type: "line",
      xMin: latest.x,
      xMax: latest.x,
      borderColor: "rgba(51,209,122,.55)",
      borderWidth: 1,
      borderDash: [3, 4],
      label: {
        display: true,
        content: `CURRENT ${Number(latest.y).toFixed(1)}`,
        position: "start",
        backgroundColor: "rgba(8,20,16,.92)",
        color: "#33d17a",
        borderColor: "#33d17a",
        borderWidth: 1,
        padding: 5,
        font: { size: 10, weight: "bold" },
      },
    },
  };

  visibleEvents.forEach((e, i) => {
    const x = toTs(e.date);
    annotations[`eventLine${i}`] = {
      type: "line",
      xMin: x,
      xMax: x,
      borderColor: "rgba(255,179,71,.23)",
      borderWidth: 1,
      borderDash: [2, 4],
      label: {
        display: range !== "1Y" && range !== "3Y",
        content: shortEventLabel(e.event),
        position: i % 2 === 0 ? "start" : "end",
        rotation: 0,
        backgroundColor: "rgba(25,20,12,.88)",
        color: "#ffb347",
        padding: 3,
        font: { size: 9 },
      },
    };
  });

  // Preserve focus across re-renders
  const preservedFocus = indicatorFocus ? { ...indicatorFocus } : null;

  if (historyChart) historyChart.destroy();

  const lineDataset = (label) => {
    const meta = SERIES_META[label];
    const data =
      label === "UMSI" ? umsiData
        : label === "Stress" ? stressData
          : label === "Fragility" ? fragilityData
            : spxData;
    return {
      label,
      _seriesKey: label,
      data,
      yAxisID: meta.yAxisID,
      borderColor: meta.borderColor,
      backgroundColor: meta.backgroundColor,
      borderWidth: label === "UMSI" ? 1.8 : label === "SPX" ? 1.15 : 1.4,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.08,
      fill: false,
      hidden: !seriesVisibility[label],
      borderDash:
        label === "UMSI" || label === "SPX"
          ? undefined
          : label === "Stress"
            ? [4, 3]
            : [2, 3],
    };
  };

  historyChart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        lineDataset("UMSI"),
        lineDataset("Stress"),
        lineDataset("Fragility"),
        lineDataset("SPX"),
        {
          type: "scatter",
          label: "Historical Events",
          data: eventPoints,
          pointRadius: 5,
          pointHoverRadius: 8,
          borderColor: "#ffffff",
          borderWidth: 1,
          backgroundColor: "#ffb347",
        },
        {
          type: "scatter",
          label: "Current",
          data: [latest],
          pointRadius: 5,
          pointHoverRadius: 7,
          borderColor: "#ffffff",
          borderWidth: 1,
          backgroundColor: "#33d17a",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      onClick(evt, elements) {
        // Ignore brush/pan releases that moved more than a few pixels
        if (pointerDown) {
          const dx = Math.abs((evt.x ?? 0) - pointerDown.x);
          const dy = Math.abs((evt.y ?? 0) - pointerDown.y);
          pointerDown = null;
          if (dx > 6 || dy > 6) return;
        }
        // Prefer Historical Events hit when present
        if (elements?.length) {
          const eventHit = elements.find((el) => {
            const ds = historyChart.data.datasets[el.datasetIndex];
            return ds?.label === "Historical Events";
          });
          if (eventHit) {
            const ds = historyChart.data.datasets[eventHit.datasetIndex];
            const raw = ds.data[eventHit.index];
            firePointDetail(raw, history);
            return;
          }

          // Any visible line series (UMSI / Stress / Fragility / SPX) or Current / focus overlay
          const lineHit = elements.find((el) => {
            const ds = historyChart.data.datasets[el.datasetIndex];
            return ds && (ds._seriesKey || ds.label === "Current" || ds._focusOverlay);
          });
          if (lineHit) {
            const ds = historyChart.data.datasets[lineHit.datasetIndex];
            const raw = ds.data[lineHit.index];
            firePointDetail(raw, history);
            return;
          }
        }

        // Fallback: nearest UMSI point by x from click (works even with pointRadius 0)
        const xScale = historyChart.scales?.x;
        if (!xScale || !umsiData.length) return;
        const xVal = xScale.getValueForPixel(evt.x);
        if (xVal == null || Number.isNaN(xVal)) return;
        let best = umsiData[0];
        let bestDist = Math.abs(best.x - xVal);
        for (let i = 1; i < umsiData.length; i++) {
          const d = Math.abs(umsiData[i].x - xVal);
          if (d < bestDist) {
            best = umsiData[i];
            bestDist = d;
          }
        }
        // Ignore clicks far from any point (~45 calendar days)
        if (bestDist > 45 * 86400000) return;
        firePointDetail(best, history);
      },
      scales: {
        x: {
          type: "time",
          min: filteredStart,
          max: filteredEnd,
          time: {
            unit: range === "1Y" ? "month" : range === "3Y" ? "quarter" : "year",
            tooltipFormat: "yyyy-MM-dd",
          },
          grid: { color: "rgba(255,255,255,.05)" },
          ticks: {
            color: "#8d9aa9",
            maxRotation: 0,
            autoSkipPadding: 18,
          },
        },
        y: {
          min: 0,
          max: 100,
          position: "left",
          grid: { color: "rgba(255,255,255,.07)" },
          ticks: { color: "#8d9aa9", stepSize: 20 },
          title: {
            display: true,
            text: "UMSI / Stress / Fragility",
            color: "#6a7a8a",
            font: { size: 10 },
          },
        },
        y1: {
          position: "right",
          display: seriesVisibility.SPX,
          grid: { drawOnChartArea: false },
          ticks: {
            color: "rgba(120,180,140,.9)",
            callback(v) {
              return Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
            },
          },
          title: {
            display: true,
            text: "S&P 500",
            color: "rgba(120,180,140,.85)",
            font: { size: 10 },
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: "#c9d2dc",
            boxWidth: 11,
            usePointStyle: true,
            filter(item) {
              // Hide Current / focus overlay from legend clutter
              return item.text !== "Current" && item.text !== "Factor extremes";
            },
          },
          onClick(e, legendItem, legend) {
            const chart = legend.chart;
            const index = legendItem.datasetIndex;
            const ds = chart.data.datasets[index];
            if (!ds) return;

            if (ds._seriesKey) {
              setSeriesVisibility(ds._seriesKey, ds.hidden);
              return;
            }

            // Default Chart.js toggle for Historical Events
            ds.hidden = !ds.hidden;
            chart.update("none");
          },
        },
        tooltip: {
          displayColors: true,
          callbacks: {
            title(items) {
              const raw = items?.[0]?.raw;
              return raw?.date || new Date(raw?.x || 0).toISOString().slice(0, 10);
            },
            label(ctx) {
              const r = ctx.raw || {};
              if (ctx.dataset.label === "Historical Events") {
                return [
                  `${r.event}`,
                  `UMSI: ${r.y ?? "—"}`,
                  `Stress: ${r.stress ?? "—"}`,
                  `Fragility: ${r.fragility ?? "—"}`,
                  "Click for detail",
                ];
              }
              if (ctx.dataset.label === "Current") {
                return `Current UMSI: ${Number(r.y).toFixed(1)}`;
              }
              if (ctx.dataset._focusOverlay) {
                return [
                  `Factor extreme: ${r.factorScore != null ? Number(r.factorScore).toFixed(1) : "—"}`,
                  `UMSI: ${r.umsi ?? r.y ?? "—"}`,
                  "Click for day detail",
                ];
              }
              if (ctx.dataset._seriesKey === "SPX") {
                return [
                  `S&P 500: ${r.y != null ? Number(r.y).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}`,
                  `UMSI: ${r.umsi ?? "—"}`,
                  "Click for day detail",
                ];
              }
              if (ctx.dataset._seriesKey === "Stress") {
                return [
                  `Stress: ${r.y ?? "—"}`,
                  `UMSI: ${r.umsi ?? "—"}`,
                  `Fragility: ${r.fragility ?? "—"}`,
                  "Click for day detail",
                ];
              }
              if (ctx.dataset._seriesKey === "Fragility") {
                return [
                  `Fragility: ${r.y ?? "—"}`,
                  `UMSI: ${r.umsi ?? "—"}`,
                  `Stress: ${r.stress ?? "—"}`,
                  "Click for day detail",
                ];
              }
              return [
                `UMSI: ${r.y ?? "—"}`,
                `Stress: ${r.stress ?? "—"}`,
                `Fragility: ${r.fragility ?? "—"}`,
                `S&P 500: ${r.sp500 ?? "—"}`,
                `Model quality: ${r.quality != null ? `${Math.round(r.quality * 100)}%` : "—"}`,
                "Click for day detail",
              ];
            },
          },
        },
        annotation: { annotations },
        zoom: {
          limits: {
            x: { min: filteredStart, max: filteredEnd, minRange: 14 * 86400000 },
            y: { min: 0, max: 100 },
            // y1 auto-scales with visible data (no hard limits)
          },
          pan: {
            enabled: true,
            mode: "x",
            modifierKey: "shift",
            onPanComplete({ chart }) { emitRangeChange(chart); },
          },
          zoom: {
            mode: "x",
            drag: {
              enabled: true,
              backgroundColor: "rgba(158,231,255,.14)",
              borderColor: "rgba(158,231,255,.65)",
              borderWidth: 1,
              threshold: 8,
            },
            wheel: { enabled: true, modifierKey: "ctrl" },
            pinch: { enabled: true },
            onZoomComplete({ chart }) { emitRangeChange(chart); },
          },
        },
      },
    },
  });

  emitRangeChange(historyChart);
  syncSeriesChips();
  emitVisibilityChange();

  // Re-apply indicator focus after chart rebuild
  if (preservedFocus) {
    indicatorFocus = null; // allow setIndicatorFocus to re-apply
    setIndicatorFocus(preservedFocus);
  } else {
    updateFocusBanner(null);
  }

  if (!canvas._umsiPointerBound) {
    canvas._umsiPointerBound = true;
    canvas.addEventListener("pointerdown", (e) => {
      const rect = canvas.getBoundingClientRect();
      pointerDown = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
  }
}
