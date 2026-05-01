/* Cost Predictor — interactive Monte Carlo demo.
 * Plain ES2020+. No frameworks, no charting libs. Hand-rolled SVG.
 *
 * Math model (per trial t in [1..N]):
 *   for each payer p:
 *     billed_p     = monthlyBilled * mix[p]
 *     denied_t_p   = clamp(denial_p + N(0, denial_p*0.15), 0, 1)
 *     realization_t_p = Beta(α_p, β_p)    // conditional on non-denial
 *     realized_t     += billed_p * (1 - denied_t_p) * realization_t_p
 * Quantiles drawn from the sorted realized_t array.
 *
 * Per-payer priors copied from cost-predictor/config/adjudication_params.yaml.
 */
(function () {
  "use strict";

  /* ---- Constants ------------------------------------------------------- */

  const PAYER_PRIORS = {
    medicare_ffs:       { denial: 0.084, gcr_alpha: 5,  gcr_beta: 5,  lag_mu: 2.6, lag_sigma: 0.3 },
    medicare_advantage: { denial: 0.157, gcr_alpha: 5,  gcr_beta: 5,  lag_mu: 2.8, lag_sigma: 0.4 },
    medicaid_ffs:       { denial: 0.151, gcr_alpha: 3,  gcr_beta: 7,  lag_mu: 3.3, lag_sigma: 0.5 },
    medicaid_mco:       { denial: 0.167, gcr_alpha: 3,  gcr_beta: 7,  lag_mu: 3.4, lag_sigma: 0.6 },
    commercial:         { denial: 0.151, gcr_alpha: 6,  gcr_beta: 5,  lag_mu: 3.4, lag_sigma: 0.4 },
    self_pay:           { denial: 0.0,   gcr_alpha: 1,  gcr_beta: 19, lag_mu: 4.5, lag_sigma: 1.0 },
  };

  const PAYER_LABELS = {
    medicare_ffs:       "Medicare FFS",
    medicare_advantage: "Medicare Advantage",
    medicaid_ffs:       "Medicaid FFS",
    medicaid_mco:       "Medicaid MCO",
    commercial:         "Commercial",
    self_pay:           "Self-pay",
  };

  // HRSA UDS Texas payer-mix defaults (uninsured → self_pay; medicaid_chip split into FFS/MCO; medicare split FFS/MA)
  const DEFAULT_MIX = {
    medicare_ffs:       7,
    medicare_advantage: 8,
    medicaid_ffs:       5,
    medicaid_mco:       25,
    commercial:         27,
    self_pay:           28,
  };

  const PAYERS = Object.keys(PAYER_PRIORS);

  /* ---- Random helpers -------------------------------------------------- */

  // Box-Muller standard normal
  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // Marsaglia–Tsang Gamma(shape k>=1, scale θ=1). For k<1 use boost trick.
  function randGamma(k) {
    if (k < 1) {
      // Johnk's-style boost: G(k) = G(k+1) * U^(1/k)
      const g = randGamma(k + 1);
      return g * Math.pow(Math.random(), 1 / k);
    }
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do {
        x = randn();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  // Beta(α, β) = X / (X + Y), X~Gamma(α), Y~Gamma(β)
  function randBeta(alpha, beta) {
    const x = randGamma(alpha);
    const y = randGamma(beta);
    return x / (x + y);
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  /* ---- Formatters ------------------------------------------------------ */

  function fmtMoney(v) {
    if (!isFinite(v)) return "—";
    const sign = v < 0 ? "−" : "";
    const a = Math.abs(v);
    if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return sign + "$" + Math.round(a / 1e3).toLocaleString() + "K";
    return sign + "$" + Math.round(a).toLocaleString();
  }
  function fmtMoneyExact(v) {
    if (!isFinite(v)) return "—";
    const sign = v < 0 ? "−" : "";
    return sign + "$" + Math.round(Math.abs(v)).toLocaleString();
  }
  function fmtPct(p, digits) {
    return (p * 100).toFixed(digits == null ? 1 : digits) + "%";
  }

  /* ---- Slider state ---------------------------------------------------- */

  const state = {
    monthlyBilled: 5_000_000,
    bonusRate: 0.05,
    trials: 1000,
    mix: { ...DEFAULT_MIX },
    // freeze map of payer -> bool: if true, soft-renormalize will not touch this slider while user holds another
    locked: {},
  };

  /* ---- Slider rendering ------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function buildPayerSliders() {
    const root = $("payer-mix");
    root.innerHTML = "";
    PAYERS.forEach((p) => {
      const wrap = document.createElement("div");
      wrap.className = "field";
      wrap.innerHTML =
        '<div class="field__head">' +
        '<span class="field__label">' + PAYER_LABELS[p] + "</span>" +
        '<span class="field__value" data-mix-value="' + p + '">' + state.mix[p] + "%</span>" +
        "</div>" +
        '<input type="range" min="0" max="100" step="1" value="' + state.mix[p] + '" ' +
        'data-mix="' + p + '" aria-label="' + PAYER_LABELS[p] + " percentage" + '">' +
        '<div class="field__sub" data-mix-dollar="' + p + '"></div>';
      root.appendChild(wrap);
    });

    root.querySelectorAll('input[type="range"][data-mix]').forEach((sl) => {
      sl.addEventListener("input", (e) => onMixChange(e.target.dataset.mix, +e.target.value));
    });
  }

  /**
   * Soft-renormalize: when one payer slider moves, the others scale
   * proportionally so the total stays at 100. If "others" sum to 0, distribute equally.
   */
  function onMixChange(payer, newVal) {
    newVal = Math.max(0, Math.min(100, newVal));
    const oldOthersTotal = 100 - state.mix[payer];
    const newOthersTotal = 100 - newVal;
    const others = PAYERS.filter((p) => p !== payer);

    if (oldOthersTotal <= 0.0001) {
      // edge case: one slider was at 100, distribute equally
      const each = newOthersTotal / others.length;
      others.forEach((p) => (state.mix[p] = each));
    } else {
      const ratio = newOthersTotal / oldOthersTotal;
      others.forEach((p) => (state.mix[p] = state.mix[p] * ratio));
    }
    state.mix[payer] = newVal;
    normalizeMix();
    syncMixUI();
    schedulerRecompute();
  }

  function normalizeMix() {
    // numerical drift guard
    const total = PAYERS.reduce((s, p) => s + state.mix[p], 0);
    if (total <= 0.0001) {
      PAYERS.forEach((p) => (state.mix[p] = 100 / PAYERS.length));
      return;
    }
    PAYERS.forEach((p) => (state.mix[p] = (state.mix[p] / total) * 100));
  }

  function syncMixUI() {
    PAYERS.forEach((p) => {
      const sl = document.querySelector('input[data-mix="' + p + '"]');
      const valEl = document.querySelector('[data-mix-value="' + p + '"]');
      const dollarEl = document.querySelector('[data-mix-dollar="' + p + '"]');
      const v = state.mix[p];
      if (sl && Math.abs(+sl.value - v) > 0.5) sl.value = Math.round(v);
      if (valEl) valEl.textContent = v.toFixed(0) + "%";
      if (dollarEl) dollarEl.textContent =
        fmtMoneyExact((v / 100) * state.monthlyBilled) + " billed";
    });
    const totalEl = $("mix-total");
    if (totalEl) {
      const total = PAYERS.reduce((s, p) => s + state.mix[p], 0);
      totalEl.textContent = total.toFixed(0) + "%";
    }
  }

  /* ---- Simulation ------------------------------------------------------ */

  function simulate() {
    const N = state.trials;
    const monthly = state.monthlyBilled;
    const trials = new Float64Array(N);

    // Pre-compute billed per payer (constant across trials)
    const billed = {};
    PAYERS.forEach((p) => (billed[p] = monthly * (state.mix[p] / 100)));

    for (let t = 0; t < N; t++) {
      let realized = 0;
      for (let i = 0; i < PAYERS.length; i++) {
        const p = PAYERS[i];
        const prior = PAYER_PRIORS[p];
        const denialJitter = randn() * (prior.denial * 0.15);
        const denied = clamp01(prior.denial + denialJitter);
        const gcr = randBeta(prior.gcr_alpha, prior.gcr_beta);
        realized += billed[p] * (1 - denied) * gcr;
      }
      trials[t] = realized;
    }

    // Sort copy for quantiles
    const sorted = Array.from(trials).sort((a, b) => a - b);
    const q = (frac) => sorted[Math.min(N - 1, Math.max(0, Math.round(frac * (N - 1))))];

    const p10 = q(0.10);
    const p50 = q(0.50);
    const p90 = q(0.90);

    // Per-payer p50 expected realized (run a small inner mean — analytic for speed)
    const perPayerRealized = {};
    PAYERS.forEach((p) => {
      const prior = PAYER_PRIORS[p];
      const expectedFactor = (1 - prior.denial) *
        (prior.gcr_alpha / (prior.gcr_alpha + prior.gcr_beta));
      perPayerRealized[p] = billed[p] * expectedFactor;
    });

    return { trials: sorted, p10, p50, p90, billed, perPayerRealized, N };
  }

  /* ---- Scheduler (rAF-throttled recompute) ---------------------------- */

  let pending = false;
  function schedulerRecompute() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      recompute();
    });
  }

  function recompute() {
    const t0 = performance.now();
    const res = simulate();
    renderHeadline(res);
    renderBarChart(res);
    renderHistogram(res);
    renderBadge(res);
    const dt = performance.now() - t0;
    const perfEl = $("perf");
    if (perfEl) perfEl.textContent =
      "computed in " + dt.toFixed(0) + " ms · " + res.N.toLocaleString() + " trials";
  }

  /* ---- Headline numbers ----------------------------------------------- */

  function renderHeadline(res) {
    const safePool = res.p10 * state.bonusRate;
    const naivePool = state.monthlyBilled * state.bonusRate;
    const saved = naivePool - safePool;

    $("hd-p50").textContent = fmtMoney(res.p50);
    $("hd-p10").textContent = fmtMoney(res.p10);
    $("hd-p90").textContent = fmtMoney(res.p90);
    $("hd-safe").textContent = fmtMoneyExact(safePool);
    $("hd-naive").textContent = fmtMoneyExact(naivePool);
    $("hd-saved").textContent = fmtMoneyExact(saved);

    $("hd-p50-sub").textContent = "median across " + res.N.toLocaleString() + " trials";
    $("hd-p10-sub").textContent = "10th percentile · conservative";
    $("hd-p90-sub").textContent = "90th percentile · upside";
  }

  /* ---- Per-payer bar chart -------------------------------------------- */

  function renderBarChart(res) {
    const svg = $("chart-bars");
    if (!svg) return;
    const w = svg.viewBox.baseVal.width || 720;
    const rowH = 40;
    const padTop = 18;
    const padBottom = 18;
    const padLeft = 130;
    const padRight = 110;
    const h = padTop + padBottom + PAYERS.length * rowH;
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("height", h);

    const maxBilled = Math.max(...PAYERS.map((p) => res.billed[p]));
    const xMax = w - padRight;

    let svgInner = "";

    // Axis line
    svgInner += '<line x1="' + padLeft + '" y1="' + (padTop - 6) + '" x2="' + padLeft + '" y2="' + (h - padBottom + 4) + '" stroke="#1B1A17" stroke-width="1"/>';

    // Hatch pattern definition (only define once on first call)
    if (!svg.querySelector("defs")) {
      const defs = '<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#C9C0AE" stroke-width="2"/></pattern></defs>';
      svgInner += defs;
    }

    PAYERS.forEach((p, i) => {
      const yTop = padTop + i * rowH;
      const yMid = yTop + rowH / 2;
      const billedW = (res.billed[p] / maxBilled) * (xMax - padLeft);
      const realizedW = (res.perPayerRealized[p] / maxBilled) * (xMax - padLeft);

      // Label
      svgInner += '<text x="' + (padLeft - 12) + '" y="' + (yMid + 4) +
        '" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#3C3A35" text-anchor="end">' +
        PAYER_LABELS[p] + "</text>";

      // Billed bar (light hatched)
      svgInner += '<rect x="' + padLeft + '" y="' + (yTop + 8) +
        '" width="' + billedW + '" height="' + (rowH - 18) +
        '" fill="url(#hatch)" stroke="#C9C0AE" stroke-width="0.5"/>';

      // Realized bar (dark, narrower)
      svgInner += '<rect x="' + padLeft + '" y="' + (yTop + 13) +
        '" width="' + realizedW + '" height="' + (rowH - 28) +
        '" fill="#1B1A17"/>';

      // Right-side dollar label (realized over billed)
      const realPct = res.billed[p] > 0
        ? (res.perPayerRealized[p] / res.billed[p]) * 100
        : 0;
      svgInner += '<text x="' + (xMax + 10) + '" y="' + (yMid + 4) +
        '" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" font-variant-numeric="tabular-nums" fill="#1B1A17">' +
        fmtMoney(res.perPayerRealized[p]) +
        '<tspan fill="#9A9286"> · ' + realPct.toFixed(0) + "%</tspan></text>";
    });

    // Legend
    const lgY = h - 4;
    svgInner += '<rect x="' + padLeft + '" y="' + (lgY - 8) + '" width="10" height="6" fill="url(#hatch)" stroke="#C9C0AE" stroke-width="0.5"/>';
    svgInner += '<text x="' + (padLeft + 14) + '" y="' + (lgY - 2) +
      '" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" letter-spacing="0.05em" fill="#6B655B">BILLED</text>';
    svgInner += '<rect x="' + (padLeft + 80) + '" y="' + (lgY - 8) + '" width="10" height="6" fill="#1B1A17"/>';
    svgInner += '<text x="' + (padLeft + 94) + '" y="' + (lgY - 2) +
      '" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" letter-spacing="0.05em" fill="#6B655B">REALIZED · MEAN</text>';

    svg.innerHTML = svgInner;
  }

  /* ---- Forecast distribution histogram -------------------------------- */

  function renderHistogram(res) {
    const svg = $("chart-hist");
    if (!svg) return;
    const w = svg.viewBox.baseVal.width || 720;
    const h = 280;
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("height", h);

    const padTop = 24;
    const padBottom = 38;
    const padLeft = 24;
    const padRight = 24;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    const trials = res.trials;
    const min = trials[0];
    const max = trials[trials.length - 1];
    const span = (max - min) || 1;
    const nBins = 40;
    const bins = new Array(nBins).fill(0);
    for (let i = 0; i < trials.length; i++) {
      let idx = Math.floor(((trials[i] - min) / span) * nBins);
      if (idx >= nBins) idx = nBins - 1;
      if (idx < 0) idx = 0;
      bins[idx]++;
    }
    const maxCount = Math.max(...bins);

    const xOf = (v) => padLeft + ((v - min) / span) * plotW;

    let svgInner = "";

    // Baseline
    svgInner += '<line x1="' + padLeft + '" y1="' + (padTop + plotH) +
      '" x2="' + (padLeft + plotW) + '" y2="' + (padTop + plotH) + '" stroke="#1B1A17" stroke-width="1"/>';

    // Bars
    const binW = plotW / nBins;
    for (let i = 0; i < nBins; i++) {
      const c = bins[i];
      if (c === 0) continue;
      const bh = (c / maxCount) * plotH;
      const x = padLeft + i * binW;
      const y = padTop + plotH - bh;
      svgInner += '<rect x="' + (x + 0.5) + '" y="' + y +
        '" width="' + (binW - 1) + '" height="' + bh +
        '" fill="#1B1A17" opacity="0.18"/>';
    }

    // Quantile lines + labels
    function vline(v, label, color, position) {
      const x = xOf(v);
      svgInner += '<line x1="' + x + '" y1="' + padTop + '" x2="' + x +
        '" y2="' + (padTop + plotH) + '" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="2,3"/>';
      // pip on baseline
      svgInner += '<circle cx="' + x + '" cy="' + (padTop + plotH) + '" r="2.5" fill="' + color + '"/>';
      // label
      const labelY = position === "top" ? padTop - 8 : padTop + plotH + 18;
      svgInner += '<text x="' + x + '" y="' + labelY +
        '" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" letter-spacing="0.12em" text-anchor="middle" fill="' + color + '" font-weight="600">' +
        label + "</text>";
      // value
      const valY = position === "top" ? padTop - 22 : padTop + plotH + 32;
      svgInner += '<text x="' + x + '" y="' + valY +
        '" font-family="\'Iowan Old Style\', Charter, ui-serif, Georgia, serif" font-style="italic" font-size="13" font-variant-numeric="tabular-nums" text-anchor="middle" fill="#1B1A17">' +
        fmtMoney(v) + "</text>";
    }
    vline(res.p10, "P10", "#7A2E2E", "top");
    vline(res.p50, "P50", "#1B1A17", "bottom");
    vline(res.p90, "P90", "#6B655B", "top");

    // Axis end ticks
    svgInner += '<text x="' + padLeft + '" y="' + (padTop + plotH + 18) +
      '" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" fill="#9A9286">' + fmtMoney(min) + "</text>";
    svgInner += '<text x="' + (padLeft + plotW) + '" y="' + (padTop + plotH + 18) +
      '" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" fill="#9A9286" text-anchor="end">' + fmtMoney(max) + "</text>";

    svg.innerHTML = svgInner;
  }

  /* ---- Calibration badge ---------------------------------------------- */

  function renderBadge(res) {
    const el = $("breach-badge");
    if (!el) return;
    // Trivially 0% on a sorted distribution where p10 IS the cutoff,
    // but we present this as the calibration cue: how many trials fall
    // below the bonus pool's safety margin (i.e., would breach a clinic
    // sized at 90% of p10).
    const safetyCutoff = res.p10 * 0.9; // 10% buffer below p10
    let breaches = 0;
    for (let i = 0; i < res.trials.length; i++) {
      if (res.trials[i] < safetyCutoff) breaches++;
      else break; // sorted
    }
    const rate = breaches / res.trials.length;
    el.textContent = "Breach risk · " + fmtPct(rate, 1);
    el.classList.toggle("badge--good", rate <= 0.10);
    el.classList.toggle("badge--warn", rate > 0.10);
  }

  /* ---- Wire up controls ------------------------------------------------ */

  function init() {
    if (!$("payer-mix")) return;

    buildPayerSliders();
    syncMixUI();

    $("monthly-billed").addEventListener("input", (e) => {
      state.monthlyBilled = +e.target.value;
      $("monthly-billed-value").textContent = fmtMoneyExact(state.monthlyBilled);
      syncMixUI();
      schedulerRecompute();
    });

    $("bonus-rate").addEventListener("input", (e) => {
      state.bonusRate = +e.target.value / 100;
      $("bonus-rate-value").textContent = (+e.target.value).toFixed(1) + "%";
      schedulerRecompute();
    });

    document.querySelectorAll('input[name="trials"]').forEach((r) => {
      r.addEventListener("change", (e) => {
        if (e.target.checked) {
          state.trials = +e.target.value;
          schedulerRecompute();
        }
      });
    });

    // Initial values
    $("monthly-billed-value").textContent = fmtMoneyExact(state.monthlyBilled);
    $("bonus-rate-value").textContent = (state.bonusRate * 100).toFixed(1) + "%";

    schedulerRecompute();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
