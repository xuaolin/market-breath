let historyChart;

const rangeDays = {
  "1Y": 365,
  "3Y": 365 * 3,
  "5Y": 365 * 5,
  "10Y": 365 * 10,
  "MAX": Infinity,
};

function filterRange(series, range) {
  if (range === "MAX") return series;
  const days = rangeDays[range] || 365;
  const maxDate = new Date(series.at(-1)?.date || Date.now());
  const minDate = new Date(maxDate.getTime() - days * 86400000);
  return series.filter(p => new Date(p.date) >= minDate);
}

export function renderHistoryChart(history, range = "5Y") {
  const canvas = document.getElementById("historyChart");
  if (!canvas || !history?.series?.length) return;
  const filtered = filterRange(history.series, range);
  const eventMap = new Map((history.events || []).map(e => [e.date, e]));
  const eventPoints = filtered
    .filter(p => eventMap.has(p.date))
    .map(p => ({ x: p.date, y: p.umsi, event: eventMap.get(p.date).event }));

  if (historyChart) historyChart.destroy();
  historyChart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        {
          label: "UMSI",
          data: filtered.map(p => ({ x: p.date, y: p.umsi })),
          borderColor: "#9ee7ff",
          borderWidth: 1.6,
          pointRadius: 0,
          tension: 0.08,
        },
        {
          type: "scatter",
          label: "Historical Events",
          data: eventPoints,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderColor: "#ffffff",
          backgroundColor: "#ffb347",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "time",
          time: { unit: range === "1Y" ? "month" : "year" },
          grid: { color: "rgba(255,255,255,.05)" },
          ticks: { color: "#8d9aa9", maxRotation: 0 },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: "rgba(255,255,255,.07)" },
          ticks: { color: "#8d9aa9", stepSize: 20 },
        },
      },
      plugins: {
        legend: { labels: { color: "#c9d2dc", boxWidth: 12 } },
        tooltip: {
          callbacks: {
            afterLabel(ctx) {
              return ctx.raw?.event ? `Event: ${ctx.raw.event}` : "";
            },
          },
        },
        annotation: {
          annotations: {
            fearZone: {
              type: "box", yMin: 0, yMax: 15,
              backgroundColor: "rgba(255, 71, 87, .08)", borderWidth: 0,
            },
            complacencyZone: {
              type: "box", yMin: 90, yMax: 100,
              backgroundColor: "rgba(165, 94, 234, .10)", borderWidth: 0,
            },
            fearLine: { type: "line", yMin: 15, yMax: 15, borderColor: "rgba(255,71,87,.45)", borderDash: [5, 5], borderWidth: 1 },
            complacencyLine: { type: "line", yMin: 90, yMax: 90, borderColor: "rgba(165,94,234,.55)", borderDash: [5, 5], borderWidth: 1 },
          },
        },
      },
    },
  });
}
