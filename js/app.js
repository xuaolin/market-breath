import { fmt, scoreClass, signedPct, freshness } from "./calculations.js";
import { renderHistoryChart } from "./charts.js";

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

function renderTop(daily, intraday) {
  setScoreCard("umsiValue", daily.umsi?.value);
  setText("umsiRegime", daily.umsi?.regime || "—");

  setText("stressValue", fmt(daily.stress?.value, 1));
  setText("stressStatus", daily.stress?.status || "—");
  setText("fragilityValue", fmt(daily.fragility?.value, 1));
  setText("fragilityStatus", daily.fragility?.status || "—");

  const liveSP = intraday.sp500?.value ?? daily.market?.sp500?.value;
  const liveChg = intraday.sp500?.change_pct ?? daily.market?.sp500?.change_pct;
  setText("sp500Value", fmt(liveSP, 2));
  setText("sp500Change", signedPct(liveChg, 2));
  setText("sp500State", daily.market?.sp500?.status || "—");

  setText("regimeValue", daily.umsi?.regime || "—");
  setText("qualityValue", `${fmt((daily.umsi?.calculation_quality || 0) * 100, 0)}% inputs`);
  setText("lastUpdated", daily.generated_at ? new Date(daily.generated_at).toLocaleString() : "Awaiting first update");

  const stale = Object.values(daily.indicators || {}).some(x => x.stale) || intraday.sp500?.stale;
  const badge = document.getElementById("freshnessBadge");
  if (badge) {
    badge.textContent = freshness(stale);
    badge.classList.toggle("stale", Boolean(stale));
  }
}

function renderIndicators(daily) {
  const tbody = document.querySelector("#indicatorTable tbody");
  tbody.innerHTML = "";
  Object.values(daily.indicators || {}).forEach(item => {
    const tr = document.createElement("tr");
    const raw = item.label?.includes("Drawdown") ? fmt((item.raw_value || 0) * 100, 2, "%") : fmt(item.raw_value, 4);
    tr.innerHTML = `
      <td><div class="indicator-name">${item.label}</div><div class="subtle">${item.source_date || "No source date"}${item.stale ? " · STALE" : ""}</div></td>
      <td>${raw}</td>
      <td>${fmt(item.percentile, 1, "%")}</td>
      <td><span class="score-pill ${scoreClass(item.score)}">${fmt(item.score, 1)}</span></td>
      <td>${fmt((item.weight || 0) * 100, 0, "%")}</td>
      <td>${fmt(item.contribution, 2)}</td>
      <td>${item.status || "—"}</td>`;
    tbody.appendChild(tr);
  });
}

function retCell(v) {
  if (v == null) return "—";
  const cls = Number(v) >= 0 ? "positive" : "negative";
  return `<span class="${cls}">${signedPct(v, 1)}</span>`;
}

function renderForward(history) {
  const tbody = document.querySelector("#forwardTable tbody");
  tbody.innerHTML = "";
  (history.forward_returns || []).forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.range}</td><td>${r.observations}</td><td>${retCell(r.return_1m)}</td><td>${retCell(r.return_3m)}</td><td>${retCell(r.return_6m)}</td><td>${retCell(r.return_12m)}</td>`;
    tbody.appendChild(tr);
  });
}

function renderEvents(history) {
  const tbody = document.querySelector("#eventsTable tbody");
  tbody.innerHTML = "";
  (history.events || []).forEach(e => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${e.date}</td><td>${e.event}</td><td>${fmt(e.umsi, 1)}</td><td>${fmt(e.stress, 1)}</td><td>${fmt(e.fragility, 1)}</td><td>${retCell(e.return_1m)}</td><td>${retCell(e.return_3m)}</td><td>${retCell(e.return_6m)}</td>`;
    tbody.appendChild(tr);
  });
}

function renderSources(daily) {
  const list = document.getElementById("sourceList");
  list.innerHTML = "";
  (daily.sources || []).forEach(s => {
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `${s.name} — ${s.use}`;
    list.appendChild(a);
  });
}

function bindRangeButtons(history) {
  document.querySelectorAll("[data-range]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-range]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderHistoryChart(history, btn.dataset.range);
    });
  });
}

async function main() {
  try {
    const [daily, intraday, history] = await Promise.all([
      getJSON("data/daily.json"),
      getJSON("data/intraday.json"),
      getJSON("data/history.json"),
    ]);
    renderTop(daily, intraday);
    renderIndicators(daily);
    renderForward(history);
    renderEvents(history);
    renderSources(daily);
    renderHistoryChart(history, "5Y");
    bindRangeButtons(history);

    if (daily.status !== "ok") {
      document.getElementById("systemMessage").textContent = "Run the GitHub Action once to populate live market data.";
      document.getElementById("systemMessage").hidden = false;
    }
  } catch (err) {
    console.error(err);
    const msg = document.getElementById("systemMessage");
    msg.textContent = `Dashboard data could not be loaded: ${err.message}`;
    msg.hidden = false;
  }
}

main();
