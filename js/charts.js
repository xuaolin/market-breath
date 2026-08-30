let historyChart;

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

export function renderHistoryChart(history, range = "5Y") {
  const canvas = document.getElementById("historyChart");
  if (!canvas || !history?.series?.length) return;

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
  }));

  const eventPoints = visibleEvents.map(e => ({
    x: toTs(e.date),
    y: e.umsi,
    event: e.event,
    stress: e.stress,
    fragility: e.fragility,
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
          pointRadius: 4,
          pointHoverRadius: 6,
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
      scales: {
        x: {
          type: "time",
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
      },
    },
  });
}
