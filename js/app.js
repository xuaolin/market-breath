import { fmt, scoreClass, signedPct, freshness } from "./calculations.js";
import {
  renderHistoryChart,
  resetHistoryZoom,
  findNearestSeriesPoint,
  extractFactorBreakdown,
  setSeriesVisibility,
  getSeriesVisibility,
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

function zoneIndex(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  for (let i = 0; i < UMSI_BINS.length; i++) {
    const [lo, hi] = UMSI_BINS[i];
    if (n >= lo && n < hi) return i;
  }
  return null;
}

function regimeHeadline(daily) {
  return daily.umsi?.regime || "—";
}

function regimeSubline(daily, history) {
  const parts = [];
  const dd = daily.market?.sp500?.drawdown_52w;
  if (dd != null && Number.isFinite(Number(dd))) {
    const v = Number(dd);
    parts.push(`52W ${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
  }
  const series = history?.series || [];
  const umsi = daily.umsi?.value;
  if (series.length > 5 && umsi != null) {
    const prev = series[series.length - 6]?.umsi;
    if (prev != null && Number.isFinite(Number(prev))) {
      const d = Number(umsi) - Number(prev);
      parts.push(`1W ${d >= 0 ? "+" : ""}${d.toFixed(1)}`);
    }
  }
  const pc = daily.indicators?.put_call?.status;
  if (pc) parts.push(`P/C ${pc}`);
  return parts.join(" · ") || "—";
}

function fwdFrom(series, i, days) {
  if (!series || i + days >= series.length) return null;
  const a = Number(series[i]?.sp500);
  const b = Number(series[i + days]?.sp500);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b / a) - 1) * 100;
}

function stats(arr) {
  const xs = arr.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (!xs.length) return { mean: null, std: null, hit: null };
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const std = xs.length > 1
    ? Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length - 1))
    : null;
  const hit = (xs.filter((v) => v > 0).length / xs.length) * 100;
  return { mean, std, hit };
}

function computeForwardTable(series) {
  if (!series?.length) return { rows: [], baseline: {} };
  const horizons = [
    ["1m", 21],
    ["3m", 63],
    ["6m", 126],
    ["12m", 252],
  ];
  const baseline = {};
  horizons.forEach(([key, days]) => {
    baseline[key] = stats(series.map((_, i) => fwdFrom(series, i, days))).mean;
  });

  const entries = [];
  let i = 0;
  while (i < series.length) {
    const z = zoneIndex(series[i].umsi);
    if (z == null) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < series.length && zoneIndex(series[j].umsi) === z) j += 1;
    if (j - i >= 5) entries.push({ index: i, zone: z });
    i = j;
  }

  const rows = UMSI_BINS.map(([lo, hi], zi) => {
    const sample = entries.filter((e) => e.zone === zi);
    const row = {
      range: `${lo}–${hi === 101 ? 100 : hi}`,
      observations: sample.length,
      sampling: "first_entry_min5",
      small_sample: sample.length < 30,
    };
    horizons.forEach(([key, days]) => {
      const s = stats(sample.map((e) => fwdFrom(series, e.index, days)));
      const bh = baseline[key];
      row[`return_${key}`] = s.mean;
      row[`std_${key}`] = s.std;
      row[`hit_${key}`] = s.hit;
      row[`excess_${key}`] = s.mean != null && bh != null ? s.mean - bh : null;
    });
    return row;
  });
  return { rows, baseline };
}

function renderTop(daily, intraday, history) {
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

  setText("regimeValue", regimeSubline(daily, history));
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
  const computed = computeForwardTable(history.series || []);
  const rows = computed.rows.length ? computed.rows : (history.forward_returns || []);
  const noteEl = document.getElementById("forwardRangeNote");
  if (noteEl && computed.rows.length) {
    const bh = computed.baseline;
    const bits = ["1M", "3M", "6M", "12M"].map((lab, i) => {
      const v = [bh["1m"], bh["3m"], bh["6m"], bh["12m"]][i];
      return v == null ? null : `${lab} BH ${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    }).filter(Boolean);
    noteEl.hidden = false;
    noteEl.textContent =
      "First stay ≥5 days in zone vs buy-and-hold. n<30 greyed. " +
      (bits.length ? `Unconditional BH: ${bits.join(" · ")}.` : "");
  }
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    if (r.small_sample || (r.observations != null && r.observations < 30)) {
      tr.classList.add("small-sample");
      tr.title = "Small sample (n < 30); treat as illustrative only";
    }
    const note = r.sampling ? " entries" : "";
    const cell = (mean, std, hit, excess) => {
      if (mean == null) return "—";
      const extra = [];
      if (std != null) extra.push(`σ ${Number(std).toFixed(1)}`);
      if (hit != null) extra.push(`${Number(hit).toFixed(0)}%+`);
      if (excess != null && Number.isFinite(Number(excess))) {
        extra.push(`xs ${Number(excess) >= 0 ? "+" : ""}${Number(excess).toFixed(1)}`);
      }
      return `${retCell(mean)}${extra.length ? `<div class="subtle">${extra.join(" · ")}</div>` : ""}`;
    };
    tr.innerHTML =
      `<td>${r.range}</td><td>${r.observations}${note}${r.small_sample ? " · n small" : ""}</td>` +
      `<td>${cell(r.return_1m, r.std_1m, r.hit_1m, r.excess_1m)}</td>` +
      `<td>${cell(r.return_3m, r.std_3m, r.hit_3m, r.excess_3m)}</td>` +
      `<td>${cell(r.return_6m, r.std_6m, r.hit_6m, r.excess_6m)}</td>` +
      `<td>${cell(r.return_12m, r.std_12m, r.hit_12m, r.excess_12m)}</td>`;
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
  const isSnapshot = !event.event || event.event === "UMSI snapshot";

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

  const returnsBlock = isSnapshot
    ? ""
    : `
      <div class="event-detail-section">Forward returns</div>
      <div class="event-detail-grid compact">
        ${returns
          .map(
            ([k, v]) =>
              `<div><span class="k">${k}</span><span class="v">${v == null ? "—" : signedPct(v, 1)}</span></div>`
          )
          .join("")}
      </div>`;

  panel.hidden = false;
  panel.setAttribute("aria-hidden", "false");
  panel.innerHTML = `
    <div class="event-detail-card" role="dialog" aria-labelledby="eventDetailTitle">
      <div class="event-detail-head">
        <div>
          <div id="eventDetailTitle" class="event-detail-title${isSnapshot ? " snapshot" : ""}">${
            event.event || "UMSI snapshot"
          }</div>
          <div class="event-detail-sub">${event.date}${
            point?.date && point.date !== event.date ? ` · nearest series ${point.date}` : ""
          }</div>
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
      ${returnsBlock}
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
    onSeriesVisibilityChange: syncSeriesChipState,
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

    renderTop(daily, intraday, history);

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
    bindSeriesChips();
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
