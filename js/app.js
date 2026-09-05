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
  setText(
    "lastUpdated",
    daily.generated_at ? new Date(daily.generated_at).toLocaleString() : "Awaiting first update"
  );

  const stale =
    Object.values(daily.indicators || {}).some((x) => x.stale) ||
    Boolean(intraday.sp500?.stale);

  const badge = document.getElementById("freshnessBadge");
  if (badge) {
    badge.textContent = freshness(stale);
    badge.classList.toggle("stale", Boolean(stale));
  }
}

function formatRaw(key, item) {
  const v = item?.raw_value;
  if (v == null) return "—";

  if (key === "drawdown") return `${(Number(v) * 100).toFixed(2)}%`;
  if (key === "term") return Number(v).toFixed(3);
  if (key === "credit") return `${Number(v).toFixed(2)}%`;
  if (key === "vix") return Number(v).toFixed(2);
  if (key === "put_call") return Number(v).toFixed(2);
  if (key === "aaii") return Number(v).toFixed(1);
  if (key === "breadth") return Number(v).toFixed(4);
  return fmt(v, 4);
}

function renderIndicators(daily) {
  const tbody = document.querySelector("#indicatorTable tbody");
  tbody.innerHTML = "";

  Object.entries(daily.indicators || {}).forEach(([key, item]) => {
    const tr = document.createElement("tr");
    const source = item.source_date || "No source date";
    const stale = item.stale ? " · STALE" : "";
    const effectiveWeight =
      item.effective_weight != null
        ? ` title="Effective weight after re-normalization: ${(item.effective_weight * 100).toFixed(1)}%"`
        : "";

    tr.innerHTML = `
      <td>
        <div class="indicator-name">${item.label}</div>
        <div class="subtle">${source}${stale}</div>
      </td>
      <td>${formatRaw(key, item)}</td>
      <td>${fmt(item.percentile, 1, "%")}</td>
      <td><span class="score-pill ${scoreClass(item.score)}">${fmt(item.score, 1)}</span></td>
      <td${effectiveWeight}>${fmt((item.weight || 0) * 100, 0, "%")}</td>
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
  (history.forward_returns || []).forEach((r) => {
    const tr = document.createElement("tr");
    const note = r.sampling === "first_entry" ? " entries" : "";
    const cell = (mean, std, hit) => {
      if (mean == null) return "—";
      const extra = [];
      if (std != null) extra.push(`σ ${Number(std).toFixed(1)}`);
      if (hit != null) extra.push(`${Number(hit).toFixed(0)}%+`);
      return `${retCell(mean)}${extra.length ? `<div class="subtle">${extra.join(" · ")}</div>` : ""}`;
    };
    tr.innerHTML =
      `<td>${r.range}</td><td>${r.observations}${note}</td>` +
      `<td>${cell(r.return_1m, r.std_1m, r.hit_1m)}</td>` +
      `<td>${cell(r.return_3m, r.std_3m, r.hit_3m)}</td>` +
      `<td>${cell(r.return_6m, r.std_6m, r.hit_6m)}</td>` +
      `<td>${cell(r.return_12m, r.std_12m, r.hit_12m)}</td>`;
    tbody.appendChild(tr);
  });
}

function renderEvents(history) {
  const tbody = document.querySelector("#eventsTable tbody");
  tbody.innerHTML = "";
  (history.events || []).forEach((e) => {
    const tr = document.createElement("tr");
    tr.className = "event-row";
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `Show details for ${e.event} on ${e.date}`);
    tr.innerHTML =
      `<td>${e.date}</td><td>${e.event}</td><td>${fmt(e.umsi, 1)}</td>` +
      `<td>${fmt(e.stress, 1)}</td><td>${fmt(e.fragility, 1)}</td>` +
      `<td>${retCell(e.return_1m)}</td><td>${retCell(e.return_3m)}</td>` +
      `<td>${retCell(e.return_6m)}</td>`;
    const open = () => showEventDetail({ event: e, history });
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
    tbody.appendChild(tr);
  });
}

function renderSources(daily) {
  const list = document.getElementById("sourceList");
  list.innerHTML = "";
  (daily.sources || []).forEach((s) => {
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `${s.name} — ${s.use}`;
    list.appendChild(a);
  });
}

function statTriple(s) {
  if (!s) return "—";
  return `avg ${fmt(s.avg, 1)} · min ${fmt(s.min, 1)} · max ${fmt(s.max, 1)}`;
}

function updateRangeSummary(payload) {
  const el = document.getElementById("rangeSummary");
  if (!el || !payload?.summary) return;
  const s = payload.summary;
  const note = document.getElementById("forwardRangeNote");

  el.hidden = false;
  el.innerHTML = `
    <div class="range-summary-head">
      <div>
        <div class="range-summary-title">Selected window</div>
        <div class="range-summary-dates">${s.start || "—"} → ${s.end || "—"} · ${s.count} obs · preset ${payload.preset || "—"}</div>
      </div>
      <button type="button" id="resetZoomBtn" class="ghost-btn" title="Reset brush / zoom to preset range">Reset zoom</button>
    </div>
    <div class="range-summary-grid">
      <div><span class="k">UMSI</span><span class="v">${statTriple(s.umsi)}</span></div>
      <div><span class="k">Stress</span><span class="v">${statTriple(s.stress)}</span></div>
      <div><span class="k">Fragility</span><span class="v">${statTriple(s.fragility)}</span></div>
      <div><span class="k">SPX Δ</span><span class="v ${s.spxChange == null ? "" : s.spxChange >= 0 ? "positive" : "negative"}">${s.spxChange == null ? "—" : signedPct(s.spxChange, 2)}</span></div>
    </div>
  `;

  const resetBtn = document.getElementById("resetZoomBtn");
  if (resetBtn) resetBtn.addEventListener("click", () => resetHistoryZoom());

  if (note) {
    note.hidden = false;
    note.textContent =
      "Forward-return table remains full-sample (not filtered by chart brush).";
  }
}

function showEventDetail({ event, nearest, factors, history }) {
  const panel = document.getElementById("eventDetail");
  if (!panel || !event) return;

  const series = history?.series || [];
  const point = nearest || findNearestSeriesPoint(series, event.date);
  const factorList = factors || extractFactorBreakdown(point);

  const core = [
    ["UMSI", event.umsi ?? point?.umsi],
    ["Stress", event.stress ?? point?.stress],
    ["Fragility", event.fragility ?? point?.fragility],
    ["S&P 500", point?.sp500],
    ["Model quality", point?.quality != null ? `${Math.round(point.quality * 100)}%` : null],
  ];

  const returns = [
    ["1M fwd", event.return_1m],
    ["3M fwd", event.return_3m],
    ["6M fwd", event.return_6m],
  ];

  const factorHtml =
    factorList.length > 0
      ? factorList
          .map(
            (f) =>
              `<div class="event-factor"><span>${f.label}</span><span>${fmt(f.value, 1)}${
                f.contribution != null ? ` · contrib ${fmt(f.contribution, 2)}` : ""
              }</span></div>`
          )
          .join("")
      : `<div class="event-factor muted">No per-factor scores in history.json for this date. Showing series / event fields only.</div>`;

  panel.hidden = false;
  panel.setAttribute("aria-hidden", "false");
  panel.innerHTML = `
    <div class="event-detail-card" role="dialog" aria-labelledby="eventDetailTitle">
      <div class="event-detail-head">
        <div>
          <div id="eventDetailTitle" class="event-detail-title">${event.event || "Historical event"}</div>
          <div class="event-detail-sub">${event.date}${point?.date && point.date !== event.date ? ` · nearest series ${point.date}` : ""}</div>
        </div>
        <button type="button" class="ghost-btn" id="closeEventDetail" aria-label="Close event detail">Close</button>
      </div>
      <div class="event-detail-grid">
        ${core
          .map(
            ([k, v]) =>
              `<div><span class="k">${k}</span><span class="v">${typeof v === "number" ? fmt(v, 1) : v ?? "—"}</span></div>`
          )
          .join("")}
      </div>
      <div class="event-detail-section">Forward returns</div>
      <div class="event-detail-grid compact">
        ${returns
          .map(
            ([k, v]) =>
              `<div><span class="k">${k}</span><span class="v">${v == null ? "—" : signedPct(v, 1)}</span></div>`
          )
          .join("")}
      </div>
      <div class="event-detail-section">Factor breakdown</div>
      <div class="event-factors">${factorHtml}</div>
    </div>
  `;

  const close = () => {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = "";
  };
  document.getElementById("closeEventDetail")?.addEventListener("click", close);
  panel.querySelector(".event-detail-card")?.focus?.();
}

function chartCallbacks(history) {
  return {
    onRangeChange: updateRangeSummary,
    onEventClick: ({ event, nearest, factors }) =>
      showEventDetail({ event, nearest, factors, history }),
  };
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

    renderTop(daily, intraday);

    const indicators = daily.indicators || {};
    const quality = Number(daily.umsi?.calculation_quality);
    const anyScoreNull = Object.values(indicators).some(
      (item) => item && (item.score == null || Number.isNaN(Number(item.score)))
    );
    const breadthUnavailable =
      !indicators.breadth ||
      indicators.breadth.score == null ||
      indicators.breadth.status === "unavailable" ||
      String(indicators.breadth.status || "").toLowerCase().includes("unavailable");

    if (
      daily.status === "ok" &&
      ((Number.isFinite(quality) && quality < 0.85) || anyScoreNull || breadthUnavailable)
    ) {
      const message = document.getElementById("systemMessage");
      const qualityPct = Number.isFinite(quality) ? `${Math.round(quality * 100)}%` : "n/a";
      const stressQ = daily.stress?.quality;
      const fragQ = daily.fragility?.quality;
      const extras = [];
      if (stressQ != null) extras.push(`stress quality ${Math.round(Number(stressQ) * 100)}%`);
      if (fragQ != null) extras.push(`fragility quality ${Math.round(Number(fragQ) * 100)}%`);
      const reasons = [];
      if (Number.isFinite(quality) && quality < 0.85) {
        reasons.push(`calculation quality is ${qualityPct}`);
      }
      if (anyScoreNull) reasons.push("one or more indicator scores are missing");
      if (breadthUnavailable) reasons.push("market breadth is unavailable");
      message.textContent =
        `Data quality warning: ${reasons.join("; ")}` +
        (extras.length ? ` (${extras.join(", ")})` : "") +
        ". Dashboard remains visible.";
      message.hidden = false;
    }

    renderIndicators(daily);
    renderForward(history);
    renderEvents(history);
    renderSources(daily);
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
