let historyChart;
let chartCallbacks = {};
let activeHistory = null;
let activeRange = "5Y";

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

export function getHistoryChart() {
  return historyChart;
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

  const lineData = filtered.map(p => ({
    x: toTs(p.date),
    y: p.umsi,
    date: p.date,
    stress: p.stress,
    fragility: p.fragility,
    sp500: p.sp500,
    quality: p.quality,
    raw: p,
  }));

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

  const latest = lineData.at(-1);

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

  if (historyChart) historyChart.destroy();

  historyChart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        {
          label: "UMSI",
          data: lineData,
          borderColor: "#9ee7ff",
          backgroundColor: "rgba(158,231,255,.03)",
          borderWidth: 1.8,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.08,
          fill: false,
        },
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
        if (!elements?.length) return;
        const hit = elements.find((el) => {
          const ds = historyChart.data.datasets[el.datasetIndex];
          return ds?.label === "Historical Events";
        });
        if (!hit) return;
        const ds = historyChart.data.datasets[hit.datasetIndex];
        const raw = ds.data[hit.index];
        if (!raw || typeof chartCallbacks.onEventClick !== "function") return;
        const nearest = findNearestSeriesPoint(history.series, raw.date);
        const factors = extractFactorBreakdown(nearest);
        chartCallbacks.onEventClick({ event: raw.raw || raw, nearest, factors });
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
          grid: { color: "rgba(255,255,255,.07)" },
          ticks: { color: "#8d9aa9", stepSize: 20 },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: "#c9d2dc",
            boxWidth: 11,
            usePointStyle: true,
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
              return [
                `UMSI: ${r.y ?? "—"}`,
                `Stress: ${r.stress ?? "—"}`,
                `Fragility: ${r.fragility ?? "—"}`,
                `S&P 500: ${r.sp500 ?? "—"}`,
                `Model quality: ${r.quality != null ? `${Math.round(r.quality * 100)}%` : "—"}`,
              ];
            },
          },
        },
        annotation: { annotations },
        zoom: {
          limits: {
            x: { min: filteredStart, max: filteredEnd, minRange: 14 * 86400000 },
            y: { min: 0, max: 100 },
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
}
