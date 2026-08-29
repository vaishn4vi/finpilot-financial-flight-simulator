/* ==========================================================================
   app.js — Frontend glue. No financial math happens here; this file only
   calls the backend API and renders whatever it returns.
   ========================================================================== */

// Measured with an instrumented headless-browser pass (canvas.width vs
// canvas.getBoundingClientRect() at DPR 1 / 1.25 / 1.5 / 2): after the
// chart-container + maintainAspectRatio fix, the backing store now tracks
// the displayed CSS size exactly — ratio == requested DPR at every level,
// no more upscale/downscale mismatch. That confirmed the *sizing* bug is
// gone. It also confirmed the *remaining* cause of softness: with
// `devicePixelRatio: Math.min(dpr, 2)`, a normal 1x external monitor
// (dpr === 1) got a 1:1 backing store — dimensionally correct, but zero
// supersampling. Unlike native DOM text, the Canvas 2D text renderer never
// gets subpixel/LCD hinting, only grayscale antialiasing — so a 1:1 canvas
// at small font sizes (10-11px axis labels, legends) reads visibly softer
// than the hinted HTML text next to it even though every pixel is mapped
// 1-to-1. A floor of 2x backing-store resolution (rendered, then the
// browser composites it down to CSS size) is what compensates for that —
// it's the same reason the original blind "force 3" idea wasn't crazy, it
// just couldn't work while the container/aspect-ratio bug above was still
// silently resampling the result. With that bug actually fixed, a modest,
// capped floor is now doing real work instead of being wasted. Floor at
// 2x, ceiling at 3x so true high-DPR devices (dpr 2-3 phones/retina) get
// their native ratio without needlessly inflating canvas memory further.
if (typeof Chart !== 'undefined') {
  const dpr = window.devicePixelRatio || 1;
  Chart.defaults.devicePixelRatio = Math.min(Math.max(dpr, 2), 3);
}

const state = {
  profile: null,
  defaults: null, // the profile's un-overridden baseline numbers, used for slider ranges + reset
  overrides: null, // current slider-derived overrides, or null if untouched
  chart: null,
  sensitivityChart: null,
  revenueCostChart: null,
  compositionChart: null,
  mcBaselineChart: null,
  mcScenarioChart: null,
  lastQuestion: null,
  sliderDebounce: null,
  mode: 'whatif', // 'whatif' | 'decide'
  lastResponse: null, // last /api/whatif or /api/decide payload, kept for the Share button
  riskRadar: null, // last /api/risk-radar response, kept for the Protect My Business button
  appMode: 'business', // 'business' | 'personal'
  personalProfile: null, // currently active personal profile object (demo or custom)
  personalStressChart: null,
  personalContext: {}, // numbers carried forward across /api/personal/ask turns
};

// Belt-and-suspenders for a separate, unrelated race: IBM Plex Mono /
// Space Grotesk load asynchronously from Google Fonts (font-display:
// swap). Regular DOM text repaints automatically the moment the real font
// swaps in; a <canvas> that already finished drawing does not — if a
// chart happens to rasterize its text before the webfont request
// resolves, that text is stuck on the fallback font. Once every
// registered @font-face has settled, force a metrics-and-repaint pass on
// whichever charts already exist so none of them are left stranded on the
// fallback. Charts created after this point already see the loaded font
// at draw time and don't need it, so this only ever matters once, for
// whatever was on screen first.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    [
      state.revenueCostChart,
      state.compositionChart,
      state.chart,
      state.sensitivityChart,
      state.mcBaselineChart,
      state.mcScenarioChart,
    ].forEach((c) => c && c.update());
  });
}

const els = {
  profileSelect: document.getElementById('profileSelect'),
  profileDesc: document.getElementById('profileDesc'),
  statCash: document.getElementById('statCash'),
  statRevenue: document.getElementById('statRevenue'),
  statBurn: document.getElementById('statBurn'),
  statGrowth: document.getElementById('statGrowth'),
  statTerms: document.getElementById('statTerms'),
  statPayroll: document.getElementById('statPayroll'),
  runwayValue: document.getElementById('runwayValue'),
  runwayStatusTag: document.getElementById('runwayStatusTag'),
  runwayGauge: document.getElementById('runwayGauge'),
  whatifForm: document.getElementById('whatifForm'),
  whatifInput: document.getElementById('whatifInput'),
  submitBtn: document.getElementById('submitBtn'),
  exampleChips: document.getElementById('exampleChips'),
  resultsSection: document.getElementById('resultsSection'),
  emptyState: document.getElementById('emptyState'),
  branchChart: document.getElementById('branchChart'),
  chartLegend: document.getElementById('chartLegend'),
  riskStrip: document.getElementById('riskStrip'),
  explanationText: document.getElementById('explanationText'),
  scenarioCards: document.getElementById('scenarioCards'),
  llmTag: document.getElementById('llmTag'),
  breakevenPanel: document.getElementById('breakevenPanel'),
  breakevenText: document.getElementById('breakevenText'),
  sensitivityPanel: document.getElementById('sensitivityPanel'),
  sensitivityChart: document.getElementById('sensitivityChart'),
  sensitivitySkippedNote: document.getElementById('sensitivitySkippedNote'),
  sliderRevenue: document.getElementById('sliderRevenue'),
  sliderGrowth: document.getElementById('sliderGrowth'),
  sliderFixed: document.getElementById('sliderFixed'),
  sliderPayroll: document.getElementById('sliderPayroll'),
  sliderRevenueValue: document.getElementById('sliderRevenueValue'),
  sliderGrowthValue: document.getElementById('sliderGrowthValue'),
  sliderFixedValue: document.getElementById('sliderFixedValue'),
  sliderPayrollValue: document.getElementById('sliderPayrollValue'),
  resetSlidersBtn: document.getElementById('resetSlidersBtn'),
  overrideNote: document.getElementById('overrideNote'),
  revenueCostChart: document.getElementById('revenueCostChart'),
  compositionChart: document.getElementById('compositionChart'),
  compositionLegend: document.getElementById('compositionLegend'),
  // New: safe limits
  safeHireValue: document.getElementById('safeHireValue'),
  safeHireNote: document.getElementById('safeHireNote'),
  safeRevenueValue: document.getElementById('safeRevenueValue'),
  safeRevenueNote: document.getElementById('safeRevenueNote'),
  safeMinCashValue: document.getElementById('safeMinCashValue'),
  // New: mode toggle
  modeToggle: document.getElementById('modeToggle'),
  decideNote: document.getElementById('decideNote'),
  micBtn: document.getElementById('micBtn'),
  // New: document upload
  docFileInput: document.getElementById('docFileInput'),
  docTextInput: document.getElementById('docTextInput'),
  extractBtn: document.getElementById('extractBtn'),
  extractResult: document.getElementById('extractResult'),
  // New: decision trace + share
  decisionTrace: document.getElementById('decisionTrace'),
  shareBtn: document.getElementById('shareBtn'),
  shareResult: document.getElementById('shareResult'),
  // New: Monte Carlo stress test (FEATURE 3)
  mcBaselineChart: document.getElementById('mcBaselineChart'),
  mcBaselineBadge: document.getElementById('mcBaselineBadge'),
  mcBaselineTrials: document.getElementById('mcBaselineTrials'),
  mcBaselineHeadline: document.getElementById('mcBaselineHeadline'),
  mcBaselineFootnote: document.getElementById('mcBaselineFootnote'),
  mcScenarioPanel: document.getElementById('mcScenarioPanel'),
  mcScenarioChart: document.getElementById('mcScenarioChart'),
  mcScenarioBadge: document.getElementById('mcScenarioBadge'),
  mcScenarioTrials: document.getElementById('mcScenarioTrials'),
  mcScenarioHeadline: document.getElementById('mcScenarioHeadline'),
  // New: Financial Risk Radar
  riskCardsGrid: document.getElementById('riskCardsGrid'),
  financialHealthScore: document.getElementById('financialHealthScore'),
  financialHealthBreakdown: document.getElementById('financialHealthBreakdown'),
  protectBusinessBtn: document.getElementById('protectBusinessBtn'),
  protectiveActions: document.getElementById('protectiveActions'),
};

const fmtMoney = (n, currency = '₹') => `${currency}${Math.round(n).toLocaleString('en-IN')}`;
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

function describeProvider(provider, providerModel) {
  if (provider === 'anthropic') return '(Anthropic — cloud LLM active)';
  if (provider === 'ollama') return `(Ollama — ${providerModel || 'local model'}, local)`;
  return '(rule-based parser active)';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  const res = await fetch('/api/profiles');
  const { profiles } = await res.json();

  els.profileSelect.innerHTML = profiles
    .map((p) => `<option value="${p.id}">${p.label}</option>`)
    .join('');

  els.profileSelect.addEventListener('change', () => loadBaseline(els.profileSelect.value));
  els.whatifForm.addEventListener('submit', onSubmitWhatIf);
  els.exampleChips.addEventListener('click', (e) => {
    if (e.target.matches('.chip')) {
      els.whatifInput.value = e.target.dataset.q;
      els.whatifForm.dispatchEvent(new Event('submit'));
    }
  });

  // Mode toggle: "What if...?" vs "What should I do?"
  els.modeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const isDecide = state.mode === 'decide';
    els.whatifInput.disabled = isDecide;
    els.whatifInput.placeholder = isDecide
      ? 'No question needed — click "Run Scenario" to get ranked turnaround strategies'
      : 'e.g. what if I hire 10 employees this quarter?';
    els.decideNote.classList.toggle('hidden', !isDecide);
    els.exampleChips.classList.toggle('hidden', isDecide);
    els.submitBtn.textContent = isDecide ? 'Get Recommendations' : 'Run Scenario';
  });

  setupVoiceInput();
  setupDocumentUpload();
  setupShareButton();
  setupRiskRadarInteractions();

  // Live sliders — debounced so dragging doesn't hammer the server, but
  // still feels immediate. Every slider change re-fetches the baseline
  // WITH overrides and redraws the gauge/stats/charts.
  [els.sliderRevenue, els.sliderGrowth, els.sliderFixed, els.sliderPayroll].forEach((slider) => {
    slider.addEventListener('input', onSliderInput);
  });

  document.querySelectorAll('.slider-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.slider;
      const dir = parseInt(btn.dataset.dir, 10);
      const slider = sliderElementFor(key);
      const step = parseFloat(slider.step) || 1;
      slider.value = clamp(parseFloat(slider.value) + dir * step, parseFloat(slider.min), parseFloat(slider.max));
      onSliderInput();
    });
  });

  els.resetSlidersBtn.addEventListener('click', () => {
    if (!state.defaults) return;
    resetSlidersToDefaults();
  });

  if (profiles.length) {
    els.profileSelect.value = profiles[0].id;
    await loadBaseline(profiles[0].id);
  }

  // If opened via a shared-scenario link (?share=ID), fetch and render it.
  const shareId = new URLSearchParams(window.location.search).get('share');
  if (shareId) {
    try {
      const res = await fetch(`/api/share/${shareId}`);
      const entry = await res.json();
      if (entry.payload) {
        const { data, type } = entry.payload;
        renderResults(data, { isDecide: type === 'decide' });
        renderDecisionTrace(data, { isDecide: type === 'decide' });
      }
    } catch (err) {
      console.error('Failed to load shared scenario:', err.message);
    }
  }

  await initPersonalMode();
  setupAppModeToggle();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sliderElementFor(key) {
  return { monthlyRevenue: els.sliderRevenue, growthRate: els.sliderGrowth, monthlyFixedCosts: els.sliderFixed, monthlyPayroll: els.sliderPayroll }[key];
}

// ---------------------------------------------------------------------------
// Baseline load (drives the gauge + stat panel + sliders + new charts)
// ---------------------------------------------------------------------------
async function loadBaseline(profileId) {
  // Fetch the RAW (un-overridden) profile first, purely to know its natural
  // defaults for slider ranges — sliders always reset to a fresh profile's
  // own numbers when you switch profiles.
  const res = await fetch(`/api/baseline/${profileId}`);
  const data = await res.json();
  state.defaults = data.profile;
  state.overrides = null;
  els.overrideNote.textContent = '';

  setSlidersFromProfile(data.profile);
  applyBaselineData(data);
  fetchAndRenderSafeLimits(profileId, null);
  fetchAndRenderMonteCarloBaseline(profileId, null);
  fetchAndRenderRiskRadar(profileId, null);

  // Reset results view when switching profiles
  els.resultsSection.classList.add('hidden');
  els.emptyState.classList.remove('hidden');
}

// Configures slider min/max/value from a profile's own numbers. Range is
// 0 → 3x the profile's natural value for revenue/costs/payroll, so "increase
// or decrease the income" has real room to move in both directions.
function setSlidersFromProfile(profile) {
  configureSlider(els.sliderRevenue, profile.monthlyRevenue);
  configureSlider(els.sliderFixed, profile.monthlyFixedCosts);
  configureSlider(els.sliderPayroll, profile.monthlyPayroll);
  els.sliderGrowth.value = (profile.growthRate * 100).toFixed(1);
  updateSliderLabels(profile);
}

function configureSlider(slider, value) {
  const max = Math.max(Math.ceil((value * 3) / 1000) * 1000, 1000);
  slider.min = 0;
  slider.max = max;
  slider.step = Math.max(Math.round(max / 200), 1);
  slider.value = value;
}

function updateSliderLabels(profile) {
  const currency = profile.currency || '₹';
  els.sliderRevenueValue.textContent = fmtMoney(els.sliderRevenue.value, currency) + '/mo';
  els.sliderFixedValue.textContent = fmtMoney(els.sliderFixed.value, currency) + '/mo';
  els.sliderPayrollValue.textContent = fmtMoney(els.sliderPayroll.value, currency) + '/mo';
  els.sliderGrowthValue.textContent = `${parseFloat(els.sliderGrowth.value).toFixed(1)}%/mo`;
}

function getCurrentOverrides() {
  return {
    monthlyRevenue: parseFloat(els.sliderRevenue.value),
    monthlyFixedCosts: parseFloat(els.sliderFixed.value),
    monthlyPayroll: parseFloat(els.sliderPayroll.value),
    growthRate: parseFloat(els.sliderGrowth.value) / 100,
  };
}

function onSliderInput() {
  updateSliderLabels(state.defaults || {});
  clearTimeout(state.sliderDebounce);
  state.sliderDebounce = setTimeout(refreshBaselineWithOverrides, 180);
}

async function refreshBaselineWithOverrides(explicitOverrides) {
  if (!state.defaults) return;
  // Range inputs snap their value to the nearest `step` even when set via
  // JS, which is fine for hand-dragging but would silently round an exact
  // figure (e.g. from document extraction) to the nearest slider notch.
  // Callers with an exact value to apply (like applyExtractedFields) pass
  // it explicitly so the simulation always uses the real number — the
  // slider's snapped position is then purely a visual approximation.
  const overrides = explicitOverrides || getCurrentOverrides();
  state.overrides = overrides;

  const isDefault =
    overrides.monthlyRevenue === state.defaults.monthlyRevenue &&
    overrides.monthlyFixedCosts === state.defaults.monthlyFixedCosts &&
    overrides.monthlyPayroll === state.defaults.monthlyPayroll &&
    Math.abs(overrides.growthRate - state.defaults.growthRate) < 0.0001;
  els.overrideNote.textContent = isDefault
    ? ''
    : 'Adjusted from profile defaults — this also applies to any "what if" question you ask below.';

  const params = new URLSearchParams({
    monthlyRevenue: overrides.monthlyRevenue,
    monthlyFixedCosts: overrides.monthlyFixedCosts,
    monthlyPayroll: overrides.monthlyPayroll,
    growthRate: overrides.growthRate,
  });
  const res = await fetch(`/api/baseline/${state.defaults.id}?${params.toString()}`);
  const data = await res.json();
  applyBaselineData(data);
  fetchAndRenderSafeLimits(state.defaults.id, overrides);
  fetchAndRenderMonteCarloBaseline(state.defaults.id, overrides);
  fetchAndRenderRiskRadar(state.defaults.id, overrides);
}

// Resets sliders to the profile's own defaults. Deliberately does NOT route
// through refreshBaselineWithOverrides()/getCurrentOverrides() — range
// inputs snap their .value to the nearest `step` even when set via JS, so
// reading the sliders back after setSlidersFromProfile() can land a tiny
// fraction off the true default (e.g. ₹24,00,000 → ₹24,12,000), which would
// both mislabel this as "adjusted from defaults" and feed the engine a
// slightly wrong number. Instead, fetch the plain no-override baseline
// directly — the exact same call the initial page load makes.
async function resetSlidersToDefaults() {
  setSlidersFromProfile(state.defaults);
  state.overrides = null;
  els.overrideNote.textContent = '';
  const res = await fetch(`/api/baseline/${state.defaults.id}`);
  const data = await res.json();
  applyBaselineData(data);
  fetchAndRenderSafeLimits(state.defaults.id, null);
  fetchAndRenderMonteCarloBaseline(state.defaults.id, null);
  fetchAndRenderRiskRadar(state.defaults.id, null);
}

// ---------------------------------------------------------------------------
// FINANCIAL RISK RADAR — always-on panel
// ---------------------------------------------------------------------------
// Mirrors fetchAndRenderSafeLimits()'s pattern exactly: a GET to the
// always-on endpoint with the same override query params, fired whenever
// the profile or live sliders change (LIVE REACTIVITY requirement). Every
// number rendered here is read verbatim from the API response — this
// function only builds DOM, it never computes a risk value itself.
async function fetchAndRenderRiskRadar(profileId, overrides) {
  try {
    const params = new URLSearchParams();
    if (overrides) {
      params.set('monthlyRevenue', overrides.monthlyRevenue);
      params.set('monthlyFixedCosts', overrides.monthlyFixedCosts);
      params.set('monthlyPayroll', overrides.monthlyPayroll);
      params.set('growthRate', overrides.growthRate);
    }
    const qs = params.toString();
    const res = await fetch(`/api/risk-radar/${profileId}${qs ? '?' + qs : ''}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.riskRadar = data;
    renderFinancialHealth(data.financialHealth);
    renderRiskCards(data.risks, data.profile.currency);

    // Collapse any previously-rendered protective actions — they were
    // computed against the OLD numbers and would be stale/misleading now.
    els.protectiveActions.classList.add('hidden');
    els.protectiveActions.innerHTML = '';
  } catch (err) {
    console.error('Risk Radar fetch failed:', err.message);
  }
}

function severityRank(sev) {
  return { high: 3, medium: 2, watch: 1, healthy: 0 }[sev] ?? 0;
}

function renderFinancialHealth(financialHealth) {
  if (!financialHealth) return;
  const score = financialHealth.score;
  els.financialHealthScore.textContent = `${score} / 100`;
  els.financialHealthScore.classList.remove('score-watch', 'score-medium', 'score-high');
  if (score < 60) els.financialHealthScore.classList.add('score-high');
  else if (score < 75) els.financialHealthScore.classList.add('score-medium');
  else if (score < 90) els.financialHealthScore.classList.add('score-watch');

  const lines = financialHealth.deductions
    .map((d) => `<div class="breakdown-line"><span>− ${d.points} ${d.label.toLowerCase()}</span></div>`)
    .join('');
  els.financialHealthBreakdown.innerHTML = `
    <div class="breakdown-line"><span>100 base</span></div>
    ${lines || '<div class="breakdown-line"><span>No deductions — every detector is healthy.</span></div>'}
    <div class="breakdown-line total"><span>= ${score} / 100</span></div>
  `;
}

function renderRiskCards(risks, currency) {
  if (!Array.isArray(risks)) return;
  els.riskCardsGrid.innerHTML = risks.map((r, idx) => riskCardHtml(r, idx)).join('');

  // "Simulate impact →" — populate the What-if input with the deterministic
  // question tied to this risk, switch to whatif mode if needed, and let
  // the user press Run Scenario (per spec: this only WIRES the button, it
  // does not auto-submit — the person stays in control of running it).
  els.riskCardsGrid.querySelectorAll('[data-simulate-question]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const question = btn.dataset.simulateQuestion;
      if (!question) return;
      populateAndFocusWhatIf(question);
    });
  });

  // Info icon toggles the auditability tooltip for that one card.
  els.riskCardsGrid.querySelectorAll('[data-info-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tooltip = document.getElementById(btn.dataset.infoToggle);
      if (tooltip) tooltip.classList.toggle('hidden');
    });
  });
}

function riskCardHtml(r, idx) {
  const sev = r.severity || 'healthy';
  const sevLabel = { high: '🔴 HIGH RISK', medium: '🟠 MEDIUM RISK', watch: '🟡 WATCH', healthy: '🟢 HEALTHY' }[sev];
  const tooltipId = `riskTooltip_${idx}`;
  const demoTag = r.isDemoData ? `<span class="risk-card-demo-tag">DEMO DATA</span>` : '';
  const simulateBtn = r.simulateQuestion
    ? `<button type="button" class="risk-card-simulate" data-simulate-question="${escapeHtml(r.simulateQuestion)}">Simulate impact →</button>`
    : '';

  return `
    <div class="risk-card sev-${sev}">
      <div class="risk-card-top">
        <span class="risk-badge sev-${sev}">${sevLabel}</span>
        <button type="button" class="risk-info-btn" data-info-toggle="${tooltipId}" title="What is this?" aria-label="Explain this risk">ⓘ</button>
      </div>
      <span class="risk-card-title">${escapeHtml(r.title)}</span>
      <span class="risk-card-value">${escapeHtml(r.value)}</span>
      <p class="risk-card-summary">${escapeHtml(r.summary)}</p>
      ${demoTag}
      <div class="risk-card-tooltip hidden" id="${tooltipId}">
        <p><strong>Why it matters:</strong> ${escapeHtml(r.whyItMatters)}</p>
        <p><strong>How it's calculated:</strong> ${escapeHtml(r.calculation)}</p>
        <p><strong>Threshold:</strong> ${escapeHtml(r.threshold)}</p>
      </div>
      ${simulateBtn}
    </div>
  `;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Switches to "What if...?" mode if the user was in "What should I do?" mode,
// fills the question field, focuses it, and scrolls the console into view —
// per spec, "Simulate impact" only PREPARES the question; the user still
// presses "Run Scenario" themselves.
function populateAndFocusWhatIf(question) {
  if (state.mode !== 'whatif') {
    const whatifBtn = document.querySelector('.mode-btn[data-mode="whatif"]');
    if (whatifBtn) whatifBtn.click();
  }
  els.whatifInput.value = question;
  els.whatifInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  els.whatifInput.focus();
}

// "PROTECT MY BUSINESS" — renders the protective actions already computed
// (and simulated) by the last /api/risk-radar response. No new simulation
// happens client-side; this only formats state.riskRadar.protectiveActions.
function renderProtectiveActions() {
  const data = state.riskRadar;
  if (!data || !Array.isArray(data.protectiveActions)) return;
  const currency = data.profile.currency || '₹';

  els.protectiveActions.innerHTML = data.protectiveActions.map((action) => {
    const impact = action.expectedImpact || {};
    const minCashLine = typeof impact.minCashDelta === 'number' && impact.minCashDelta !== 0
      ? `<span>${impact.minCashDelta > 0 ? '+' : ''}${fmtMoney(impact.minCashDelta, currency)} minimum cash</span>`
      : '';
    const endCashLine = typeof impact.endCashDelta === 'number'
      ? `<span>${impact.endCashDelta > 0 ? '+' : ''}${fmtMoney(impact.endCashDelta, currency)} projected cash at month 12</span>`
      : '';
    const applyBtn = action.simulateQuestion
      ? `<button type="button" class="protective-action-apply" data-apply-question="${escapeHtml(action.simulateQuestion)}">Apply Scenario →</button>`
      : '';
    return `
      <div class="protective-action-card">
        <h4>${escapeHtml(action.name)}</h4>
        <p>${escapeHtml(action.description)}</p>
        <div class="protective-action-impact">
          ${minCashLine}
          ${endCashLine}
        </div>
        ${applyBtn}
      </div>
    `;
  }).join('');

  els.protectiveActions.classList.remove('hidden');

  els.protectiveActions.querySelectorAll('[data-apply-question]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const question = btn.dataset.applyQuestion;
      if (!question) return;
      if (state.mode !== 'whatif') {
        const whatifBtn = document.querySelector('.mode-btn[data-mode="whatif"]');
        if (whatifBtn) whatifBtn.click();
      }
      els.whatifInput.value = question;
      // "Apply Scenario" runs it immediately through the EXISTING scenario
      // engine (same /api/whatif pipeline as every chip and manual question)
      // — no separate simulation path.
      els.whatifForm.dispatchEvent(new Event('submit'));
      els.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function setupRiskRadarInteractions() {
  els.protectBusinessBtn.addEventListener('click', () => {
    if (!state.riskRadar) return;
    const isHidden = els.protectiveActions.classList.contains('hidden');
    if (isHidden) {
      renderProtectiveActions();
    } else {
      els.protectiveActions.classList.add('hidden');
    }
  });

  els.financialHealthScore.addEventListener('click', () => {
    els.financialHealthBreakdown.classList.toggle('hidden');
  });

  // Click-away closes the score breakdown popover.
  document.addEventListener('click', (e) => {
    if (!document.getElementById('financialHealthWrap').contains(e.target)) {
      els.financialHealthBreakdown.classList.add('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// SAFE LIMITS — reverse simulation, always-on panel
// ---------------------------------------------------------------------------
async function fetchAndRenderSafeLimits(profileId, overrides) {
  try {
    const params = new URLSearchParams();
    if (overrides) {
      params.set('monthlyRevenue', overrides.monthlyRevenue);
      params.set('monthlyFixedCosts', overrides.monthlyFixedCosts);
      params.set('monthlyPayroll', overrides.monthlyPayroll);
      params.set('growthRate', overrides.growthRate);
    }
    const qs = params.toString();
    const res = await fetch(`/api/safe-limits/${profileId}${qs ? '?' + qs : ''}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const currency = data.profile.currency || '₹';
    const target = data.targetMinRunwayMonths;
    document.getElementById('safeLimitsTarget').textContent = `${target}-MO RUNWAY TARGET`;

    const hire = data.maxHiring;
    els.safeHireValue.textContent = `${hire.threshold} ${hire.threshold === 1 ? 'employee' : 'employees'}`;
    els.safeHireNote.textContent = hire.note || `Beyond this, runway drops below ${target} months.`;

    const rev = data.maxRevenueDrop;
    els.safeRevenueValue.textContent = `${(rev.threshold * 100).toFixed(1)}%`;
    els.safeRevenueNote.textContent = rev.note || `Beyond this drop, runway falls below ${target} months.`;

    const burn = data.profile.monthlyFixedCosts + data.profile.monthlyPayroll - data.profile.monthlyRevenue;
    els.safeMinCashValue.textContent = burn > 0 ? fmtMoney(burn * 2, currency) : 'Profitable';
  } catch (err) {
    console.error('Safe-limits fetch failed:', err.message);
  }
}

// Applies a /api/baseline response to the gauge, stat panel, and the two
// always-on charts. Shared by the initial load and every slider update.
// Chart rendering is wrapped defensively — if Chart.js fails to load or a
// draw call throws, the stat panel and gauge (which don't depend on it)
// still render correctly, and the safe-limits fetch below isn't blocked.
function applyBaselineData(data) {
  state.profile = data.profile;

  els.profileDesc.textContent = data.profile.description;
  els.statCash.textContent = fmtMoney(data.profile.startingCash, data.profile.currency);
  els.statRevenue.textContent = fmtMoney(data.profile.monthlyRevenue, data.profile.currency) + '/mo';
  const burn = data.profile.monthlyFixedCosts + data.profile.monthlyPayroll - data.profile.monthlyRevenue;
  els.statBurn.textContent = (burn > 0 ? fmtMoney(burn, data.profile.currency) + '/mo' : 'Profitable');
  els.statGrowth.textContent = fmtPct(data.profile.growthRate) + '/mo';
  els.statTerms.textContent = `${data.profile.paymentTermsDays} days`;
  els.statPayroll.textContent = fmtMoney(data.profile.monthlyPayroll, data.profile.currency) + '/mo';

  const runwayMonths = data.isProfitable ? 24 : Math.min(data.baselineRunwayMonths, 24);
  drawGauge(runwayMonths, data.isProfitable);

  try {
    renderRevenueCostChart(data);
    renderCompositionChart(data);
  } catch (err) {
    console.error('Chart rendering failed (Chart.js unavailable?):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Extra graphical representations (always-on, reflect slider overrides)
// ---------------------------------------------------------------------------
function renderRevenueCostChart(data) {
  const months = data.result.months;
  const currency = data.profile.currency;

  if (state.revenueCostChart) state.revenueCostChart.destroy();
  state.revenueCostChart = new Chart(els.revenueCostChart, {
    type: 'bar',
    data: {
      labels: months.map((m) => `M${m.month}`),
      datasets: [
        { label: 'Revenue', data: months.map((m) => m.revenue), backgroundColor: 'rgba(52, 211, 153, 0.75)', borderRadius: 3 },
        { label: 'Costs', data: months.map((m) => m.costs), backgroundColor: 'rgba(248, 105, 95, 0.7)', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#7C8CA0', font: { family: 'IBM Plex Mono', size: 11 }, boxWidth: 12 },
        },
        tooltip: {
          backgroundColor: '#171F2B',
          borderColor: '#232E3D',
          borderWidth: 1,
          titleColor: '#E7EEF5',
          bodyColor: '#E7EEF5',
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y, currency)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#7C8CA0', font: { family: 'IBM Plex Mono', size: 10 } } },
        y: {
          grid: { color: '#1A222E' },
          ticks: { color: '#7C8CA0', font: { family: 'IBM Plex Mono', size: 10 }, callback: (v) => fmtMoney(v, currency) },
        },
      },
    },
  });
}

function renderCompositionChart(data) {
  const p = data.profile;
  const margin = p.monthlyRevenue - p.monthlyFixedCosts - p.monthlyPayroll;
  const labels = ['Fixed Costs', 'Payroll'];
  const values = [p.monthlyFixedCosts, p.monthlyPayroll];
  const colors = ['#F5A623', '#C084FC'];

  if (margin > 0) {
    labels.push('Margin');
    values.push(margin);
    colors.push('#34D399');
  } else if (margin < 0) {
    labels.push('Shortfall (unfunded)');
    values.push(-margin);
    colors.push('#F8695F');
  }

  if (state.compositionChart) state.compositionChart.destroy();
  state.compositionChart = new Chart(els.compositionChart, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#121821' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#171F2B',
          borderColor: '#232E3D',
          borderWidth: 1,
          titleColor: '#E7EEF5',
          bodyColor: '#E7EEF5',
          callbacks: { label: (ctx) => `${ctx.label}: ${fmtMoney(ctx.parsed, p.currency)}` },
        },
      },
    },
  });

  els.compositionLegend.innerHTML = labels
    .map((label, i) => `<div class="legend-item"><span class="legend-swatch" style="background:${colors[i]}"></span>${label}: ${fmtMoney(values[i], p.currency)}</div>`)
    .join('');
}

// ---------------------------------------------------------------------------
// FEATURE 3 — Monte Carlo stress test: fan chart + plain-language confidence
// ---------------------------------------------------------------------------
// Renders a "fan chart": a shaded band of plausible cash outcomes per month
// (not a single line) plus a solid median path, built from the percentile
// data engine.monteCarloSimulate() already computed server-side. This
// function is shared by both the always-on baseline panel and the
// recommended-scenario panel — same visual language, different data source.
//
// Chart.js technique: five line datasets sharing one x-axis (months). p10
// and p25 are drawn fully transparent (invisible lines, no border) and
// exist only as fill TARGETS. p90 sets `fill: <index of p10 dataset>` to
// shade the region between them — that's the wide "80% of outcomes" band.
// p75 does the same against p25 for the narrower "50% of outcomes" band.
// p50 (median) is drawn last, as a solid visible line, on top of both
// bands. Array order = paint order in Chart.js, so bands are listed before
// the median line to keep it on top.
function chartStateKeyForCanvas(canvasKey) {
  if (canvasKey === 'mcBaselineChart') return 'mcBaselineChart';
  if (canvasKey === 'personalStressChart') return 'personalStressChart';
  return 'mcScenarioChart';
}

function renderMonteCarloFanChart(canvasKey, monteCarlo, currency) {
  const months = monteCarlo.months;
  const labels = months.map((m) => `M${m.month}`);
  const stateKey = chartStateKeyForCanvas(canvasKey);

  if (state[stateKey]) state[stateKey].destroy();

  state[stateKey] = new Chart(els[canvasKey], {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          // index 0 — invisible lower boundary for the outer (80%) band
          label: 'p10',
          data: months.map((m) => m.p10),
          borderWidth: 0,
          pointRadius: 0,
          fill: false,
          tension: 0.2,
        },
        {
          // index 1 — outer band: fills between this (p90) and dataset 0 (p10)
          label: '80% range',
          data: months.map((m) => m.p90),
          borderWidth: 0,
          pointRadius: 0,
          backgroundColor: 'rgba(56, 198, 244, 0.16)',
          fill: 0,
          tension: 0.2,
        },
        {
          // index 2 — invisible lower boundary for the inner (50%) band
          label: 'p25',
          data: months.map((m) => m.p25),
          borderWidth: 0,
          pointRadius: 0,
          fill: false,
          tension: 0.2,
        },
        {
          // index 3 — inner band: fills between this (p75) and dataset 2 (p25)
          label: '50% range',
          data: months.map((m) => m.p75),
          borderWidth: 0,
          pointRadius: 0,
          backgroundColor: 'rgba(56, 198, 244, 0.38)',
          fill: 2,
          tension: 0.2,
        },
        {
          // index 4 — median path, drawn last so it sits on top of both bands
          label: 'Median (most likely)',
          data: months.map((m) => m.p50),
          borderColor: '#38C6F4',
          borderWidth: 2.25,
          pointRadius: 0,
          fill: false,
          tension: 0.2,
        },
        {
          // index 5 — zero line, so "cash runs out" is visually obvious
          // wherever the band or median dips below it.
          label: 'Cash = 0',
          data: months.map(() => 0),
          borderColor: 'rgba(248, 105, 95, 0.55)',
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false }, // explained via the .mc-legend HTML block instead
        tooltip: {
          backgroundColor: '#171F2B',
          borderColor: '#232E3D',
          borderWidth: 1,
          titleColor: '#E7EEF5',
          bodyColor: '#E7EEF5',
          filter: (ctx) => ['80% range', '50% range', 'Median (most likely)'].includes(ctx.dataset.label),
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.label === '80% range') return `80% range up to: ${fmtMoney(ctx.parsed.y, currency)}`;
              if (ctx.dataset.label === '50% range') return `50% range up to: ${fmtMoney(ctx.parsed.y, currency)}`;
              return `Median: ${fmtMoney(ctx.parsed.y, currency)}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#7C8CA0', font: { family: 'IBM Plex Mono', size: 10 } } },
        y: {
          grid: { color: '#1A222E' },
          ticks: { color: '#7C8CA0', font: { family: 'IBM Plex Mono', size: 10 }, callback: (v) => fmtMoney(v, currency) },
        },
      },
    },
  });
}

// Shared badge + plain-language headline logic for both Monte Carlo panels.
function applyConfidenceBadge(badgeEl, headlineEl, monteCarlo) {
  const p = monteCarlo.survivalProbability;
  badgeEl.classList.remove('safe', 'warn', 'crit');
  let tier, headlineClass;
  if (p >= 80) { tier = 'safe'; headlineClass = 'mc-headline-safe'; }
  else if (p >= 50) { tier = 'warn'; headlineClass = 'mc-headline-warn'; }
  else { tier = 'crit'; headlineClass = 'mc-headline-crit'; }
  badgeEl.classList.add(tier);
  badgeEl.textContent = `${p.toFixed(0)}% STAY CASH-POSITIVE`;

  if (headlineEl) {
    if (p >= 95) {
      headlineEl.innerHTML = `<span class="${headlineClass}">Result: ${p.toFixed(0)}% of those simulated futures never ran out of cash</span> — a comfortable margin.`;
    } else if (p >= 80) {
      headlineEl.innerHTML = `<span class="${headlineClass}">Result: ${p.toFixed(0)}% of those simulated futures never ran out of cash</span> — solid, but not bulletproof.`;
    } else if (p >= 50) {
      headlineEl.innerHTML = `<span class="${headlineClass}">Result: only ${p.toFixed(0)}% of those simulated futures avoided running out of cash</span> — worth a closer look before committing.`;
    } else {
      headlineEl.innerHTML = `<span class="${headlineClass}">Result: just ${p.toFixed(0)}% of those simulated futures avoided running out of cash</span> — this is fragile even before anything unusual happens.`;
    }
  }
}

async function fetchAndRenderMonteCarloBaseline(profileId, overrides) {
  try {
    const params = new URLSearchParams();
    if (overrides) {
      params.set('monthlyRevenue', overrides.monthlyRevenue);
      params.set('monthlyFixedCosts', overrides.monthlyFixedCosts);
      params.set('monthlyPayroll', overrides.monthlyPayroll);
      params.set('growthRate', overrides.growthRate);
    }
    const qs = params.toString();
    const res = await fetch(`/api/montecarlo/${profileId}${qs ? '?' + qs : ''}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const currency = data.profile.currency || '₹';
    const mc = data.monteCarlo;
    renderMonteCarloFanChart('mcBaselineChart', mc, currency);
    applyConfidenceBadge(els.mcBaselineBadge, els.mcBaselineHeadline, mc);
    els.mcBaselineTrials.textContent = mc.trials;
    els.mcBaselineFootnote.textContent =
      `Typical (median) ending cash: ${fmtMoney(mc.endCash.p50, currency)}. ` +
      `Worst-case observed across all ${mc.trials} runs: ${fmtMoney(mc.worstCase.minEndCash, currency)}` +
      (mc.worstCase.earliestInsolvencyMonth
        ? ` (cash ran out as early as month ${mc.worstCase.earliestInsolvencyMonth} in ${mc.worstCase.insolventTrialPct.toFixed(0)}% of runs).`
        : ', and cash never went negative in any simulated run.');
  } catch (err) {
    console.error('Monte Carlo baseline fetch failed:', err.message);
  }
}

async function fetchAndRenderMonteCarloScenario(profileId, overrides, opts = {}) {
  try {
    const body = { profileId, overrides };
    if (opts.isDecide) body.mode = 'decide';
    else body.question = opts.question;

    const res = await fetch('/api/montecarlo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const currency = (state.defaults && state.defaults.currency) || '₹';
    const mc = data.monteCarlo;
    els.mcScenarioPanel.classList.remove('hidden');
    renderMonteCarloFanChart('mcScenarioChart', mc, currency);
    applyConfidenceBadge(els.mcScenarioBadge, els.mcScenarioHeadline, mc);
    els.mcScenarioTrials.textContent = mc.trials;
  } catch (err) {
    console.error('Monte Carlo scenario fetch failed:', err.message);
    els.mcScenarioPanel.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Gauge (SVG semicircle instrument)
// ---------------------------------------------------------------------------
function polarToCartesian(cx, cy, r, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = Math.abs(startAngle - endAngle) <= 180 ? '0' : '1';
  const sweep = startAngle > endAngle ? '1' : '0';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} ${sweep} ${end.x} ${end.y}`;
}

function drawGauge(months, isProfitable) {
  const MAX = 18; // scale caps at 18 months for legibility
  const cx = 120, cy = 130, r = 95;
  const clamped = Math.max(0, Math.min(months, MAX));
  const valueToAngle = (v) => 180 - (v / MAX) * 180;

  const bands = [
    { from: 0, to: 3, color: 'var(--red)' },
    { from: 3, to: 6, color: 'var(--yellow)' },
    { from: 6, to: MAX, color: 'var(--green)' },
  ];

  const bandPaths = bands
    .map((b) => `<path d="${describeArc(cx, cy, r, valueToAngle(b.from), valueToAngle(b.to))}"
        stroke="${b.color}" stroke-width="14" fill="none" stroke-linecap="butt" opacity="0.85" />`)
    .join('');

  const needleAngle = valueToAngle(clamped);
  const needleTip = polarToCartesian(cx, cy, r - 18, needleAngle);

  els.runwayGauge.innerHTML = `
    ${bandPaths}
    <circle cx="${cx}" cy="${cy}" r="6" fill="var(--ink)" />
    <line x1="${cx}" y1="${cy}" x2="${needleTip.x}" y2="${needleTip.y}"
          stroke="var(--ink)" stroke-width="3" stroke-linecap="round" />
    <text x="${cx - 88}" y="${cy + 14}" fill="var(--muted)" font-size="9" font-family="IBM Plex Mono">0</text>
    <text x="${cx + 82}" y="${cy + 14}" fill="var(--muted)" font-size="9" font-family="IBM Plex Mono">${MAX}+</text>
  `;

  els.runwayValue.textContent = isProfitable ? '∞' : clamped.toFixed(1);
  els.runwayStatusTag.textContent = isProfitable
    ? 'PROFITABLE'
    : clamped < 3 ? 'CRITICAL' : clamped < 6 ? 'CAUTION' : 'SAFE';
  els.runwayStatusTag.className = 'panel-sub' + (isProfitable || clamped >= 6 ? '' : clamped < 3 ? ' crit' : ' warn');
}

// ---------------------------------------------------------------------------
// What-if / Decide submission
// ---------------------------------------------------------------------------
async function onSubmitWhatIf(e) {
  e.preventDefault();
  if (!state.profile) return;

  if (state.mode === 'decide') {
    return onSubmitDecide();
  }

  const question = els.whatifInput.value.trim();
  if (!question) return;
  state.lastQuestion = question;

  els.submitBtn.disabled = true;
  els.submitBtn.textContent = 'Running…';

  try {
    const res = await fetch('/api/whatif', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: state.defaults.id, question, overrides: state.overrides }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.lastResponse = { type: 'whatif', question, data };
    renderResults(data);
    renderDecisionTrace(data);
    fetchAndRenderSensitivity(state.defaults.id, question); // FEATURE 1, fire-and-forget alongside the main render
    fetchAndRenderMonteCarloScenario(state.defaults.id, state.overrides, { question }); // FEATURE 3b, same pattern
  } catch (err) {
    alert('Simulation failed: ' + err.message);
  } finally {
    els.submitBtn.disabled = false;
    els.submitBtn.textContent = 'Run Scenario';
  }
}

// "What should I do?" mode — no free-text question needed. Runs the current
// (possibly slider-adjusted) business numbers through agent.buildDecisionStrategies().
async function onSubmitDecide() {
  els.submitBtn.disabled = true;
  els.submitBtn.textContent = 'Analyzing…';

  try {
    const res = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: state.defaults.id, overrides: state.overrides }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    // Normalize shape to match /api/whatif's response so renderResults() works unmodified.
    const normalized = { ...data, intents: [{ type: 'decide' }], baseline: engineBaselineFallback(data) };
    state.lastResponse = { type: 'decide', data: normalized };
    renderResults(normalized, { isDecide: true });
    renderDecisionTrace(normalized, { isDecide: true });
    els.sensitivityPanel.classList.add('hidden'); // sensitivity is only meaningful for a specific shock scenario
    fetchAndRenderMonteCarloScenario(state.defaults.id, state.overrides, { isDecide: true }); // FEATURE 3b
  } catch (err) {
    alert('Decision analysis failed: ' + err.message);
  } finally {
    els.submitBtn.disabled = false;
    els.submitBtn.textContent = 'Get Recommendations';
  }
}

// /api/decide doesn't return a `baseline` series (there's no single "no
// shock" baseline distinct from the "Hold current course" strategy already
// in its scenario list) — reuse that scenario's own result as the dashed
// comparison line so renderChart() doesn't need a special case.
function engineBaselineFallback(data) {
  const hold = data.scenarios.find((s) => s.name === 'Hold current course');
  return hold ? hold.result : data.scenarios[0].result;
}

// ---------------------------------------------------------------------------
// Voice input (Web Speech API) — mic button transcribes into the question
// field and, on a final result, submits it through the existing pipeline.
// ---------------------------------------------------------------------------
function setupVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    els.micBtn.disabled = true;
    els.micBtn.title = 'Voice input not supported in this browser';
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let listening = false;

  els.micBtn.addEventListener('click', () => {
    if (state.mode === 'decide') return; // no text field to fill in decide mode
    if (listening) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
      listening = true;
      els.micBtn.classList.add('recording');
    } catch (err) {
      console.error('Voice input failed to start:', err.message);
    }
  });

  recognition.addEventListener('result', (e) => {
    const transcript = e.results[0][0].transcript;
    els.whatifInput.value = transcript;
  });

  recognition.addEventListener('end', () => {
    listening = false;
    els.micBtn.classList.remove('recording');
  });

  recognition.addEventListener('error', (e) => {
    listening = false;
    els.micBtn.classList.remove('recording');
    console.error('Voice recognition error:', e.error);
  });
}

// ---------------------------------------------------------------------------
// Financial document input (MVP) — reads a pasted-or-uploaded CSV/plain-text
// file client-side, sends the raw text to /api/extract (a deterministic
// regex extractor, NOT an LLM), and applies whatever it finds as slider
// overrides feeding the same simulation engine as everything else.
// ---------------------------------------------------------------------------
function setupDocumentUpload() {
  els.docFileInput.addEventListener('change', () => {
    const file = els.docFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { els.docTextInput.value = reader.result; };
    reader.readAsText(file);
  });

  els.extractBtn.addEventListener('click', async () => {
    const text = els.docTextInput.value.trim();
    if (!text) {
      els.extractResult.textContent = 'Paste some text or choose a file first.';
      return;
    }
    els.extractBtn.disabled = true;
    els.extractBtn.textContent = 'Extracting…';
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const fields = Object.keys(data.extracted);
      if (fields.length === 0) {
        els.extractResult.textContent = data.notes.join(' ');
        return;
      }

      applyExtractedFields(data.extracted);
      els.extractResult.textContent = `Applied: ${fields
        .map((f) => `${f} = ${fmtMoney(data.extracted[f], state.profile ? state.profile.currency : '₹')}`)
        .join(', ')}`;
    } catch (err) {
      els.extractResult.textContent = 'Extraction failed: ' + err.message;
    } finally {
      els.extractBtn.disabled = false;
      els.extractBtn.textContent = 'Extract & apply to simulation';
    }
  });
}

// Maps extracted document fields onto the existing slider overrides and
// re-runs the baseline exactly the way a manual slider drag would.
// Maps extracted document fields onto the existing slider overrides and
// re-runs the baseline exactly the way a manual slider drag would — except
// the actual simulation override uses the EXACT extracted figures (see
// refreshBaselineWithOverrides's explicitOverrides param), not whatever the
// step-quantized slider position rounds to. The slider still moves to the
// nearest visual notch so the control stays usable afterward, but the
// number the engine actually simulates is never silently rounded.
function applyExtractedFields(extracted) {
  if (!state.defaults) return;

  const exact = {
    monthlyRevenue: extracted.monthlyRevenue !== undefined ? extracted.monthlyRevenue : parseFloat(els.sliderRevenue.value),
    monthlyFixedCosts: extracted.monthlyFixedCosts !== undefined ? extracted.monthlyFixedCosts : parseFloat(els.sliderFixed.value),
    monthlyPayroll: extracted.monthlyPayroll !== undefined ? extracted.monthlyPayroll : parseFloat(els.sliderPayroll.value),
    growthRate: parseFloat(els.sliderGrowth.value) / 100,
  };

  if (extracted.monthlyRevenue !== undefined) { configureSlider(els.sliderRevenue, extracted.monthlyRevenue); els.sliderRevenue.value = extracted.monthlyRevenue; }
  if (extracted.monthlyFixedCosts !== undefined) { configureSlider(els.sliderFixed, extracted.monthlyFixedCosts); els.sliderFixed.value = extracted.monthlyFixedCosts; }
  if (extracted.monthlyPayroll !== undefined) { configureSlider(els.sliderPayroll, extracted.monthlyPayroll); els.sliderPayroll.value = extracted.monthlyPayroll; }
  // Label the sliders with the EXACT extracted figures rather than reading
  // back the step-snapped DOM value, so the on-screen number always matches
  // what the engine is actually simulating.
  const currency = state.defaults.currency || '₹';
  els.sliderRevenueValue.textContent = fmtMoney(exact.monthlyRevenue, currency) + '/mo';
  els.sliderFixedValue.textContent = fmtMoney(exact.monthlyFixedCosts, currency) + '/mo';
  els.sliderPayrollValue.textContent = fmtMoney(exact.monthlyPayroll, currency) + '/mo';
  els.sliderGrowthValue.textContent = `${parseFloat(els.sliderGrowth.value).toFixed(1)}%/mo`;
  refreshBaselineWithOverrides(exact);

  // startingCash isn't slider-controlled; note it for the user rather than
  // silently dropping it, since overriding it would need a backend change.
  if (extracted.startingCash !== undefined) {
    els.extractResult.textContent += ` (Starting cash of ${fmtMoney(extracted.startingCash, state.profile ? state.profile.currency : '₹')} noted — not yet slider-adjustable in this build.)`;
  }
}

// ---------------------------------------------------------------------------
// Shareable scenarios
// ---------------------------------------------------------------------------
function setupShareButton() {
  els.shareBtn.addEventListener('click', async () => {
    if (!state.lastResponse) {
      els.shareResult.textContent = 'Run a scenario first.';
      return;
    }
    els.shareBtn.disabled = true;
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: state.lastResponse }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const url = `${window.location.origin}${window.location.pathname}?share=${data.id}`;
      els.shareResult.innerHTML = `Shareable link: <a href="${url}" target="_blank">${url}</a>`;
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
    } catch (err) {
      els.shareResult.textContent = 'Share failed: ' + err.message;
    } finally {
      els.shareBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Decision trace (auditability) — built entirely from fields already in the
// API response. LLM = interpretation + explanation; engine = calculations.
// ---------------------------------------------------------------------------
function renderDecisionTrace(data, opts = {}) {
  const currency = data.profile.currency || '₹';
  const steps = [];

  if (opts.isDecide) {
    steps.push({ key: 'Input', detail: `Current business numbers (profile${state.overrides ? ' + live slider overrides' : ''}) — no free text needed.` });
    steps.push({ key: 'Strategy generation', detail: `${data.scenarios.length} deterministic turnaround levers generated (cost cuts, hiring freeze, pricing, sales investment, combination).` });
  } else {
    steps.push({ key: 'User input', detail: `"${state.lastQuestion}"` });
    const intentSummary = (data.intents || [])
      .map((i) => `${i.type}${i.count ? ` (count=${i.count})` : ''}${i.pct ? ` (pct=${(i.pct * 100).toFixed(0)}%)` : ''}${i.days ? ` (days=${i.days})` : ''}`)
      .join(', ');
    steps.push({ key: 'Intent extraction', detail: `Parsed via ${describeProvider(data.provider, data.providerModel)} → ${intentSummary || 'unrecognized'}` });
    steps.push({ key: 'Scenario generation', detail: `${data.scenarios.length} branching strategies built, each a shocks[] array for the deterministic engine.` });
  }

  steps.push({ key: 'Simulation', detail: `Each strategy run independently through engine.simulate() over a 12-month horizon — zero LLM involvement.` });
  steps.push({ key: 'Risk evaluation', detail: `Months flagged safe/warning/critical based on cash position and burn; recommended path has ${data.scenarios.find((s) => s.name === data.recommendedName).result.summary.riskMonthCount} risky month(s).` });
  if (data.breakeven) {
    steps.push({ key: 'Safe-threshold analysis', detail: `Binary-searched boundary: ${data.breakeven.threshold} ${data.breakeven.unit} while keeping ${data.breakeven.targetMinRunwayMonths} months of runway.` });
  }
  steps.push({ key: 'Recommendation', detail: `"${data.recommendedName}" ranked #1 by policy: fewest critical months → highest cash floor → highest ending cash.` });
  steps.push({ key: 'Explanation', detail: `${describeProvider(data.provider, data.providerModel)} phrased the recommendation using ONLY the numbers computed above.` });

  els.decisionTrace.innerHTML = steps
    .map((s) => `<li><span class="trace-key">${s.key}:</span> <span class="trace-detail">${s.detail}</span></li>`)
    .join('');
  els.shareResult.textContent = '';
}

// ---------------------------------------------------------------------------
// Rendering: chart, risk strip, recommendation
// ---------------------------------------------------------------------------
const SCENARIO_COLORS = ['#F5A623', '#C084FC', '#38C6F4'];
const RECOMMENDED_COLOR = '#38C6F4';
const BASELINE_COLOR = '#4A5568';

function renderResults(data, opts = {}) {
  els.emptyState.classList.add('hidden');
  els.resultsSection.classList.remove('hidden');
  els.llmTag.textContent = describeProvider(data.provider, data.providerModel);

  try {
    renderChart(data);
  } catch (err) {
    console.error('Branch chart rendering failed:', err.message);
  }
  renderRiskStrip(data);
  renderClearance(data);
  renderBreakevenCallout(data);

  // Sensitivity chart and Monte Carlo scenario panel are populated by
  // separate calls — hide stale data from any previous question until the
  // new data arrives.
  if (!opts.isDecide) els.sensitivityPanel.classList.add('hidden');
  els.mcScenarioPanel.classList.add('hidden');
}

// FEATURE 2 — Break-even / safe-zone callout. Distinct styling from the
// scenario cards on purpose: this is a direct answer to a boundary
// question, not a comparison between strategies.
function describeBreakeven(breakeven, profile) {
  const targetMonths = breakeven.targetMinRunwayMonths;
  if (breakeven.shockType === 'hire') {
    return `You can safely hire up to <strong>${breakeven.threshold} ${breakeven.threshold === 1 ? 'person' : 'people'}</strong> without your runway dropping below ${targetMonths} months.`;
  }
  if (breakeven.shockType === 'revenue_shock') {
    return `You can absorb up to a <strong>${(breakeven.threshold * 100).toFixed(1)}% revenue drop</strong> and still keep at least ${targetMonths} months of runway.`;
  }
  return `Safe threshold: ${breakeven.threshold} ${breakeven.unit}.`;
}

function renderBreakevenCallout(data) {
  if (!data.breakeven) {
    els.breakevenPanel.classList.add('hidden');
    return;
  }
  els.breakevenPanel.classList.remove('hidden');
  let html = describeBreakeven(data.breakeven, data.profile);
  if (data.breakeven.note) {
    html += `<br><span class="breakeven-caveat">${data.breakeven.note}</span>`;
  }
  els.breakevenText.innerHTML = html;
}

// FEATURE 1 — Sensitivity analysis. Runs as a second, independent call
// against /api/sensitivity for the same question, then draws a horizontal
// bar chart ranking which input variable moves the recommended scenario's
// outcome the most.
async function fetchAndRenderSensitivity(profileId, question) {
  try {
    const res = await fetch('/api/sensitivity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId, question, overrides: state.overrides }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderSensitivityChart(data);
  } catch (err) {
    console.error('Sensitivity analysis failed:', err.message);
    els.sensitivityPanel.classList.add('hidden');
  }
}

function renderSensitivityChart(data) {
  const ranked = data.sensitivity.ranked;
  if (!ranked || ranked.length === 0) {
    els.sensitivityPanel.classList.add('hidden');
    return;
  }
  els.sensitivityPanel.classList.remove('hidden');

  const labels = ranked.map((r) => r.label);
  const values = ranked.map((r) => r.impactMagnitude);
  const maxValue = Math.max(...values, 1);
  const colors = ranked.map((r, i) => (i === 0 ? '#F5A623' : 'rgba(56, 198, 244, 0.55)'));

  if (state.sensitivityChart) state.sensitivityChart.destroy();
  state.sensitivityChart = new Chart(els.sensitivityChart, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderRadius: 4, barThickness: 22 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#171F2B',
          borderColor: '#232E3D',
          borderWidth: 1,
          titleColor: '#E7EEF5',
          bodyColor: '#E7EEF5',
          callbacks: {
            label: (ctx) => `Impact: ${fmtMoney(ctx.parsed.x, state.profile.currency)} (mostly via ${ranked[ctx.dataIndex].drivenBy})`,
          },
        },
      },
      scales: {
        x: {
          max: maxValue * 1.15,
          grid: { color: '#1A222E' },
          ticks: {
            color: '#7C8CA0',
            font: { family: 'IBM Plex Mono', size: 10 },
            callback: (v) => fmtMoney(v, state.profile.currency),
          },
        },
        y: {
          grid: { display: false },
          ticks: { color: '#E7EEF5', font: { family: 'IBM Plex Mono', size: 11 } },
        },
      },
    },
  });

  els.sensitivitySkippedNote.textContent = data.sensitivity.skipped.length
    ? `Not applicable to this scenario: ${data.sensitivity.skipped.map((s) => s.label).join(', ')}.`
    : '';
}

function renderChart(data) {
  const labels = data.baseline.months.map((m) => `M${m.month}`);
  const datasets = [
    {
      label: 'Baseline (no action)',
      data: data.baseline.months.map((m) => m.cash),
      borderColor: BASELINE_COLOR,
      borderDash: [4, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.25,
    },
  ];

  data.scenarios.forEach((sc, i) => {
    const isRecommended = sc.name === data.recommendedName;
    datasets.push({
      label: sc.name,
      data: sc.result.months.map((m) => m.cash),
      borderColor: isRecommended ? RECOMMENDED_COLOR : SCENARIO_COLORS[i % SCENARIO_COLORS.length],
      borderWidth: isRecommended ? 3.5 : 1.75,
      borderDash: isRecommended ? [] : [2, 2],
      pointRadius: 0,
      tension: 0.25,
      shadowBlur: isRecommended ? 12 : 0,
    });
  });

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(els.branchChart, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#171F2B',
          borderColor: '#232E3D',
          borderWidth: 1,
          titleColor: '#E7EEF5',
          bodyColor: '#E7EEF5',
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y, data.profile.currency)}`,
          },
        },
      },
      scales: {
        x: { grid: { color: '#1A222E' }, ticks: { color: '#7C8CA0', font: { family: 'IBM Plex Mono', size: 10 } } },
        y: {
          grid: { color: '#1A222E' },
          ticks: {
            color: '#7C8CA0',
            font: { family: 'IBM Plex Mono', size: 10 },
            callback: (v) => fmtMoney(v, data.profile.currency),
          },
        },
      },
    },
  });

  els.chartLegend.innerHTML = [
    `<div class="legend-item"><span class="legend-swatch" style="background:${BASELINE_COLOR}"></span>Baseline</div>`,
    ...data.scenarios.map((sc, i) => {
      const isRecommended = sc.name === data.recommendedName;
      const color = isRecommended ? RECOMMENDED_COLOR : SCENARIO_COLORS[i % SCENARIO_COLORS.length];
      return `<div class="legend-item ${isRecommended ? 'recommended' : ''}"><span class="legend-swatch" style="background:${color}"></span>${sc.name}${isRecommended ? ' ★ recommended' : ''}</div>`;
    }),
  ].join('');
}

function renderRiskStrip(data) {
  const recommended = data.scenarios.find((sc) => sc.name === data.recommendedName);
  els.riskStrip.innerHTML = recommended.result.months
    .map(
      (m) => `<div class="risk-cell ${m.risk}">
        <span class="m-label">M${m.month}</span>
        <span class="m-status">${m.risk.toUpperCase()}</span>
      </div>`
    )
    .join('');
}

function renderClearance(data) {
  els.explanationText.textContent = data.explanation;

  els.scenarioCards.innerHTML = data.scenarios
    .map((sc) => {
      const s = sc.result.summary;
      const isRecommended = sc.name === data.recommendedName;
      return `
      <div class="scenario-card ${isRecommended ? 'is-recommended' : ''}">
        <h4>${sc.name} ${isRecommended ? '<span class="tag">RECOMMENDED</span>' : ''} ${sc.isCompound ? '<span class="tag tag-compound">COMBINED</span>' : ''}</h4>
        <p>${sc.description}</p>
        <div class="metric-row"><span>Lowest cash point</span><span>${fmtMoney(s.minCash, data.profile.currency)}</span></div>
        <div class="metric-row"><span>Occurs in month</span><span>M${s.minCashMonth}</span></div>
        <div class="metric-row"><span>Risky months</span><span>${s.riskMonthCount} / 12</span></div>
        <div class="metric-row"><span>Cash at month 12</span><span>${fmtMoney(s.endCash, data.profile.currency)}</span></div>
        <div class="metric-row"><span>Goes negative?</span><span>${s.goesNegative ? `Yes (M${s.monthOfInsolvency})` : 'No'}</span></div>
      </div>`;
    })
    .join('');
}

/* ==========================================================================
   PERSONAL MODE — FinPilot Life
   Same "call the API, render whatever it returns" philosophy as the
   Business Mode code above. No financial math happens in this file.
   ========================================================================== */

const pels = {
  appModeToggle: document.getElementById('appModeToggle'),
  businessMode: document.getElementById('businessMode'),
  personalMode: document.getElementById('personalMode'),
  businessProfileControl: document.getElementById('businessProfileControl'),
  personalProfileControl: document.getElementById('personalProfileControl'),
  personalProfileSelect: document.getElementById('personalProfileSelect'),
  brandTagline: document.getElementById('brandTagline'),

  pStatIncome: document.getElementById('pStatIncome'),
  pStatExpenses: document.getElementById('pStatExpenses'),
  pStatSurplus: document.getElementById('pStatSurplus'),
  pStatSavings: document.getElementById('pStatSavings'),
  pStatInvestments: document.getElementById('pStatInvestments'),
  pStatEMI: document.getElementById('pStatEMI'),
  pStatEmergency: document.getElementById('pStatEmergency'),
  personalHealthScore: document.getElementById('personalHealthScore'),
  personalHealthRing: document.getElementById('personalHealthRing'),
  personalHealthState: document.getElementById('personalHealthState'),
  personalHealthBreakdown: document.getElementById('personalHealthBreakdown'),
  personalHealthExplanation: document.getElementById('personalHealthExplanation'),

  editPersonalProfileBtn: document.getElementById('editPersonalProfileBtn'),
  personalProfileForm: document.getElementById('personalProfileForm'),
  pfApplyBtn: document.getElementById('pfApplyBtn'),

  featureCardsGrid: document.getElementById('featureCardsGrid'),
  featurePanels: document.getElementById('featurePanels'),

  affordPrice: document.getElementById('affordPrice'),
  affordDownPct: document.getElementById('affordDownPct'),
  affordRate: document.getElementById('affordRate'),
  affordTenure: document.getElementById('affordTenure'),
  affordRunBtn: document.getElementById('affordRunBtn'),
  affordAssumptionsNote: document.getElementById('affordAssumptionsNote'),
  affordComparisonTable: document.getElementById('affordComparisonTable'),
  affordExplanation: document.getElementById('affordExplanation'),

  bvrPrice: document.getElementById('bvrPrice'),
  bvrRent: document.getElementById('bvrRent'),
  bvrAppreciation: document.getElementById('bvrAppreciation'),
  bvrRentGrowth: document.getElementById('bvrRentGrowth'),
  bvrInvestReturn: document.getElementById('bvrInvestReturn'),
  bvrRunBtn: document.getElementById('bvrRunBtn'),
  bvrCheckpointTable: document.getElementById('bvrCheckpointTable'),
  bvrVerdict: document.getElementById('bvrVerdict'),

  safeEmiRunBtn: document.getElementById('safeEmiRunBtn'),
  safeEmiResult: document.getElementById('safeEmiResult'),

  rentalPrice: document.getElementById('rentalPrice'),
  rentalDown: document.getElementById('rentalDown'),
  rentalRate: document.getElementById('rentalRate'),
  rentalMaintenance: document.getElementById('rentalMaintenance'),
  rentalOccupancy: document.getElementById('rentalOccupancy'),
  rentalCustomYield: document.getElementById('rentalCustomYield'),
  rentalRunBtn: document.getElementById('rentalRunBtn'),
  rentalResultTable: document.getElementById('rentalResultTable'),
  listingTextInput: document.getElementById('listingTextInput'),
  listingExtractBtn: document.getElementById('listingExtractBtn'),
  listingExtractResult: document.getElementById('listingExtractResult'),

  goalTarget: document.getElementById('goalTarget'),
  goalMonthly: document.getElementById('goalMonthly'),
  goalMonths: document.getElementById('goalMonths'),
  goalRunBtn: document.getElementById('goalRunBtn'),
  goalResultText: document.getElementById('goalResultText'),
  goalCompareTable: document.getElementById('goalCompareTable'),

  stressRunBtn: document.getElementById('stressRunBtn'),
  stressExplainer: document.getElementById('stressExplainer'),
  personalStressChart: document.getElementById('personalStressChart'),

  personalAskForm: document.getElementById('personalAskForm'),
  personalAskInput: document.getElementById('personalAskInput'),
  personalAskSubmit: document.getElementById('personalAskSubmit'),
  personalMicBtn: document.getElementById('personalMicBtn'),
  personalExampleChips: document.getElementById('personalExampleChips'),
  personalAskResult: document.getElementById('personalAskResult'),
  personalAskBadge: document.getElementById('personalAskBadge'),
  personalAskExplanation: document.getElementById('personalAskExplanation'),
  personalAskDataView: document.getElementById('personalAskDataView'),
  personalLlmTag: document.getElementById('personalLlmTag'),
};
els.personalStressChart = pels.personalStressChart; // reuse renderMonteCarloFanChart()

function pFmtMoney(n) { return fmtMoney(n, '₹'); }

// ---------------------------------------------------------------------------
// Lightweight count-up animation for snapshot / health numbers.
// Only runs on first load, a profile change, or a scenario update — never
// on every re-render — and formats each frame with the same formatter used
// for the final value so currency symbols/commas stay correct throughout.
// ---------------------------------------------------------------------------
function animateCountUp(el, toValue, { duration = 650, formatter = (v) => Math.round(v).toString() } = {}) {
  if (!el) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = formatter(toValue);
    return;
  }
  const fromValue = parseFloat(el.dataset.rawValue || '0') || 0;
  el.dataset.rawValue = String(toValue);
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const current = fromValue + (toValue - fromValue) * eased;
    el.textContent = formatter(current);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Mode switch (Business <-> Personal)
// ---------------------------------------------------------------------------
function setupAppModeToggle() {
  pels.appModeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.app-mode-btn');
    if (!btn) return;
    const mode = btn.dataset.appMode;
    if (mode === state.appMode) return;
    state.appMode = mode;
    document.querySelectorAll('.app-mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const isPersonal = mode === 'personal';
    pels.businessMode.classList.toggle('hidden', isPersonal);
    pels.personalMode.classList.toggle('hidden', !isPersonal);
    pels.businessProfileControl.classList.toggle('hidden', isPersonal);
    pels.personalProfileControl.classList.toggle('hidden', !isPersonal);
    pels.brandTagline.textContent = isPersonal
      ? 'FinPilot Life — Personal Financial Decision Engine'
      : 'FinPilot — AI Financial Controller';
  });
}

// ---------------------------------------------------------------------------
// Boot: personal profiles + demo data
// ---------------------------------------------------------------------------
async function initPersonalMode() {
  try {
    const res = await fetch('/api/personal/profiles');
    const { profiles, default: defaultProfile } = await res.json();
    pels.personalProfileSelect.innerHTML = profiles.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
    pels.personalProfileSelect.value = defaultProfile.id;
    state.personalProfile = defaultProfile;
    fillPersonalProfileForm(defaultProfile);
    await refreshPersonalSnapshot();
  } catch (err) {
    console.error('Failed to load personal profiles:', err.message);
  }

  pels.personalProfileSelect.addEventListener('change', async () => {
    const res = await fetch(`/api/personal/profile/${pels.personalProfileSelect.value}`);
    const { profile } = await res.json();
    state.personalProfile = profile;
    state.personalContext = {};
    fillPersonalProfileForm(profile);
    await refreshPersonalSnapshot();
  });

  pels.editPersonalProfileBtn.addEventListener('click', () => {
    pels.personalProfileForm.open = !pels.personalProfileForm.open;
  });

  pels.pfApplyBtn.addEventListener('click', async () => {
    state.personalProfile = readPersonalProfileForm();
    await refreshPersonalSnapshot();
  });

  setupFeatureCards();
  setupAffordFeature();
  setupBuyVsRentFeature();
  setupSafeEmiFeature();
  setupRentalFeature();
  setupGoalFeature();
  setupStressFeature();
  setupPersonalAsk();
  setupPersonalVoiceInput();
}

function fillPersonalProfileForm(p) {
  document.getElementById('pfIncome').value = p.income.monthly;
  document.getElementById('pfOtherIncome').value = p.income.other || 0;
  document.getElementById('pfSavings').value = p.savings.current;
  document.getElementById('pfInvestments').value = p.savings.investments || 0;
  document.getElementById('pfEmergencyFund').value = p.savings.emergencyFund || 0;
  document.getElementById('pfRent').value = p.expenses.rent;
  document.getElementById('pfFood').value = p.expenses.food;
  document.getElementById('pfUtilities').value = p.expenses.utilities;
  document.getElementById('pfTransport').value = p.expenses.transport;
  document.getElementById('pfInsurance').value = p.expenses.insurance;
  document.getElementById('pfEducation').value = p.expenses.education;
  document.getElementById('pfOtherExpense').value = p.expenses.other;
  document.getElementById('pfExistingEMI').value = (p.debt && p.debt.existingEMI) || 0;
  document.getElementById('pfDependents').value = p.dependents || 0;
  document.getElementById('pfEmergencyTarget').value = p.minEmergencyFundTarget || 6;
  document.getElementById('pfDesiredSavings').value = p.desiredMonthlySavings || 0;
}

function num(id) { return parseFloat(document.getElementById(id).value) || 0; }

function readPersonalProfileForm() {
  return {
    label: 'Custom household',
    income: { monthly: num('pfIncome'), other: num('pfOtherIncome') },
    savings: { current: num('pfSavings'), investments: num('pfInvestments'), emergencyFund: num('pfEmergencyFund') },
    expenses: {
      rent: num('pfRent'), food: num('pfFood'), utilities: num('pfUtilities'), transport: num('pfTransport'),
      insurance: num('pfInsurance'), education: num('pfEducation'), other: num('pfOtherExpense'),
    },
    debt: { existingEMI: num('pfExistingEMI') },
    dependents: num('pfDependents'),
    minEmergencyFundTarget: num('pfEmergencyTarget') || 6,
    desiredMonthlySavings: num('pfDesiredSavings'),
    incomeGrowthRate: 0,
  };
}

function personalProfilePayload() {
  return { profile: state.personalProfile };
}

// ---------------------------------------------------------------------------
// Snapshot + Financial Health
// ---------------------------------------------------------------------------
async function refreshPersonalSnapshot() {
  try {
    const res = await fetch('/api/personal/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(personalProfilePayload()),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const s = data.snapshot;
    const moneyFormatter = (v) => pFmtMoney(v);
    animateCountUp(pels.pStatIncome, s.monthlyIncome, { formatter: moneyFormatter });
    animateCountUp(pels.pStatExpenses, s.monthlyExpenses, { formatter: moneyFormatter });
    animateCountUp(pels.pStatSurplus, s.monthlySurplus, { formatter: moneyFormatter });
    animateCountUp(pels.pStatSavings, s.savings, { formatter: moneyFormatter });
    animateCountUp(pels.pStatInvestments, s.investments, { formatter: moneyFormatter });
    animateCountUp(pels.pStatEMI, s.existingEMI, { formatter: moneyFormatter });
    animateCountUp(pels.pStatEmergency, s.emergencyFund, { formatter: moneyFormatter });

    const score = data.health.score.value;
    animateCountUp(pels.personalHealthScore, score, { formatter: (v) => `${Math.round(v)} / 100` });
    const scoreColor = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--yellow)' : 'var(--red)';
    pels.personalHealthScore.style.color = scoreColor;
    if (pels.personalHealthRing) {
      pels.personalHealthRing.style.setProperty('--pct', String(Math.max(0, Math.min(100, score))));
      pels.personalHealthRing.style.setProperty('--ring-color', scoreColor);
    }
    if (pels.personalHealthState) {
      pels.personalHealthState.textContent = score >= 80 ? 'HEALTHY' : score >= 60 ? 'WATCH' : 'HIGH RISK';
      pels.personalHealthState.style.color = scoreColor;
    }
    pels.personalHealthExplanation.textContent = data.health.explanation;
    pels.personalHealthBreakdown.innerHTML = data.health.breakdown
      .map((r) => `<div class="risk-card risk-${r.severity}"><span class="risk-title">${r.title}</span><span class="risk-value">${r.value}</span><span class="risk-summary">${r.summary}</span></div>`)
      .join('');

    if (!pels.personalHealthScore.dataset.wired) {
      pels.personalHealthScore.dataset.wired = '1';
      pels.personalHealthScore.addEventListener('click', () => {
        pels.personalHealthBreakdown.classList.toggle('hidden');
      });
    }
  } catch (err) {
    console.error('Personal snapshot fetch failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Feature card switching
// ---------------------------------------------------------------------------
function setupFeatureCards() {
  const panelFor = { afford: 'panelAfford', buyvsrent: 'panelBuyVsRent', safeemi: 'panelSafeEmi', rental: 'panelRental', goal: 'panelGoal', stress: 'panelStress' };
  pels.featureCardsGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.feature-card');
    if (!btn) return;
    document.querySelectorAll('.feature-card').forEach((c) => c.classList.toggle('active', c === btn));
    document.querySelectorAll('.feature-detail').forEach((p) => p.classList.add('hidden'));
    const panel = document.getElementById(panelFor[btn.dataset.feature]);
    if (panel) panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ---------------------------------------------------------------------------
// Comparison table renderer — shared shape for "Can I Afford It?" branches
// ---------------------------------------------------------------------------
function renderAffordComparisonTable(result) {
  const branches = result.branches;
  const rows = [
    { label: 'Price', get: (b) => pFmtMoney(b.price) },
    { label: 'Down payment', get: (b) => pFmtMoney(b.downPayment) },
    { label: 'Loan amount', get: (b) => pFmtMoney(b.loanAmount) },
    { label: 'Monthly EMI', get: (b) => pFmtMoney(b.emi) },
    { label: 'Total interest', get: (b) => pFmtMoney(b.totalInterest) },
    { label: 'Lowest cash point', get: (b) => pFmtMoney(b.result.summary.minCash) },
    { label: 'Emergency fund', get: (b) => `<span class="compare-badge ${b.emergencyFund.meetsTarget ? 'safe' : 'unsafe'}">${b.emergencyFund.meetsTarget ? '✓ safe' : `${b.emergencyFund.monthsOfBufferAtMin}mo`}</span>` },
    { label: 'Surplus after', get: (b) => pFmtMoney(b.monthlySurplusAfter) },
  ];
  const names = { buyNow: 'BUY NOW', waitAndSave: `WAIT ${result.assumptions.waitMonths}M`, buyCheaper: 'CHEAPER HOME' };

  let html = '<table class="compare-table"><thead><tr><th></th>';
  html += branches.map((b) => `<th class="${b.key === result.recommendedKey ? 'recommended-col' : ''}">${names[b.key] || b.name}${b.key === result.recommendedKey ? ' ⭐' : ''}</th>`).join('');
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += `<tr><td>${row.label}</td>`;
    html += branches.map((b) => `<td class="${b.key === result.recommendedKey ? 'recommended-col' : ''}">${row.get(b)}</td>`).join('');
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

function setupAffordFeature() {
  pels.affordRunBtn.addEventListener('click', async () => {
    const price = parseFloat(pels.affordPrice.value);
    if (!price) { pels.affordAssumptionsNote.textContent = 'Enter a price first.'; return; }
    const assumptions = {};
    if (pels.affordDownPct.value) assumptions.downPaymentPct = parseFloat(pels.affordDownPct.value) / 100;
    if (pels.affordRate.value) assumptions.interestRatePct = parseFloat(pels.affordRate.value);
    if (pels.affordTenure.value) assumptions.tenureYears = parseFloat(pels.affordTenure.value);

    try {
      const res = await fetch('/api/personal/afford', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...personalProfilePayload(), price, assumptions }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const r = data.result;
      pels.affordAssumptionsNote.textContent =
        `Assumptions: ${(r.assumptions.downPaymentPct * 100).toFixed(0)}% down, ${r.assumptions.interestRatePct}% interest, ${r.assumptions.tenureYears}-year tenure, ` +
        `₹${r.assumptions.monthlyMaintenance}/mo maintenance, ₹${r.assumptions.annualPropertyTax}/yr property tax, ${r.assumptions.emergencyFundTargetMonths}-month emergency-fund target.`;
      pels.affordComparisonTable.innerHTML = renderAffordComparisonTable(r);
      pels.affordExplanation.textContent = r.why;
    } catch (err) {
      pels.affordAssumptionsNote.textContent = `Error: ${err.message}`;
    }
  });
}

function setupBuyVsRentFeature() {
  pels.bvrRunBtn.addEventListener('click', async () => {
    const price = parseFloat(pels.bvrPrice.value);
    const currentRent = parseFloat(pels.bvrRent.value) || undefined;
    if (!price) { pels.bvrVerdict.textContent = 'Enter a property price first.'; return; }
    const params = { price, currentRent };
    if (pels.bvrAppreciation.value) params.appreciationAnnualPct = parseFloat(pels.bvrAppreciation.value);
    if (pels.bvrRentGrowth.value) params.rentGrowthAnnualPct = parseFloat(pels.bvrRentGrowth.value);
    if (pels.bvrInvestReturn.value) params.investReturnAnnualPct = parseFloat(pels.bvrInvestReturn.value);

    try {
      const res = await fetch('/api/personal/buy-vs-rent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...personalProfilePayload(), ...params }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const r = data.result;
      let html = '<table class="compare-table"><thead><tr><th>Year</th><th>Net worth (BUY)</th><th>Net worth (RENT)</th><th>Buy ahead by</th></tr></thead><tbody>';
      for (const c of r.checkpoints) {
        const aheadClass = c.buyAheadBy >= 0 ? 'safe' : 'unsafe';
        html += `<tr><td>${c.years}</td><td>${pFmtMoney(c.netWorthBuy)}</td><td>${pFmtMoney(c.netWorthRent)}</td><td><span class="compare-badge ${aheadClass}">${pFmtMoney(c.buyAheadBy)}</span></td></tr>`;
      }
      html += '</tbody></table>';
      pels.bvrCheckpointTable.innerHTML = html;
      pels.bvrVerdict.textContent = r.verdict;
    } catch (err) {
      pels.bvrVerdict.textContent = `Error: ${err.message}`;
    }
  });
}

function setupSafeEmiFeature() {
  pels.safeEmiRunBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/personal/safe-emi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(personalProfilePayload()),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const r = data.result;
      pels.safeEmiResult.innerHTML = `
        <div class="safe-limit-card">
          <span class="safe-limit-label">Maximum safe EMI</span>
          <span class="safe-limit-value">${pFmtMoney(r.maxSafeEmi)}/mo</span>
          <span class="safe-limit-note">${r.note || `at your ${r.emergencyFundTargetMonths}-month emergency-fund target`}</span>
        </div>
        <div class="safe-limit-card">
          <span class="safe-limit-label">Current monthly surplus</span>
          <span class="safe-limit-value">${pFmtMoney(r.currentMonthlySurplus)}</span>
        </div>
        ${r.impliedMaxLoan != null ? `<div class="safe-limit-card">
          <span class="safe-limit-label">Implied max loan</span>
          <span class="safe-limit-value">${pFmtMoney(r.impliedMaxLoan)}</span>
          <span class="safe-limit-note">at ${r.atInterestRatePct}% / ${r.atTenureYears}y</span>
        </div>` : ''}`;
    } catch (err) {
      pels.safeEmiResult.innerHTML = `<p>Error: ${err.message}</p>`;
    }
  });
}

function setupRentalFeature() {
  pels.rentalRunBtn.addEventListener('click', async () => {
    const price = parseFloat(pels.rentalPrice.value);
    if (!price) { pels.rentalResultTable.innerHTML = '<p>Enter a purchase price first.</p>'; return; }
    const body = { price };
    if (pels.rentalDown.value) body.downPayment = parseFloat(pels.rentalDown.value);
    if (pels.rentalRate.value) body.interestRatePct = parseFloat(pels.rentalRate.value);
    if (pels.rentalMaintenance.value) body.monthlyMaintenance = parseFloat(pels.rentalMaintenance.value);
    if (pels.rentalOccupancy.value) body.occupancyMonths = parseFloat(pels.rentalOccupancy.value);
    if (pels.rentalCustomYield.value) body.customTargetYieldPct = parseFloat(pels.rentalCustomYield.value);

    try {
      const res = await fetch('/api/personal/rental-yield', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const r = data.result;
      let html = `<p class="engine-note">EMI on this property: ${pFmtMoney(r.emi)}/mo. Gross yield = annual rent ÷ price. Net yield additionally subtracts vacancy, maintenance &amp; property tax. Cash flow after financing further subtracts the EMI — these three are NOT the same number.</p>`;
      html += '<table class="compare-table"><thead><tr><th>Target yield</th><th>Required rent</th><th>Gross yield</th><th>Net yield</th><th>Cash flow after financing</th></tr></thead><tbody>';
      for (const t of r.targets) {
        html += `<tr><td>${t.targetYieldPct}%</td><td>${pFmtMoney(t.requiredRent)}</td><td>${t.grossYieldPct}%</td><td>${t.netYieldPct}%</td><td><span class="compare-badge ${t.monthlyCashFlow >= 0 ? 'safe' : 'unsafe'}">${pFmtMoney(t.monthlyCashFlow)}/mo</span></td></tr>`;
      }
      html += '</tbody></table>';
      pels.rentalResultTable.innerHTML = html;
    } catch (err) {
      pels.rentalResultTable.innerHTML = `<p>Error: ${err.message}</p>`;
    }
  });

  pels.listingExtractBtn.addEventListener('click', async () => {
    const text = pels.listingTextInput.value.trim();
    if (!text) return;
    try {
      const res = await fetch('/api/personal/extract-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.extracted.price) pels.rentalPrice.value = data.extracted.price;
      if (data.extracted.rent) pels.rentalCustomYield.value = ''; // don't guess a target yield from a stated rent
      if (data.extracted.monthlyMaintenance) pels.rentalMaintenance.value = data.extracted.monthlyMaintenance;
      pels.listingExtractResult.textContent = Object.keys(data.extracted).length
        ? `Extracted: ${JSON.stringify(data.extracted)}`
        : (data.notes || []).join(' ');
    } catch (err) {
      pels.listingExtractResult.textContent = `Error: ${err.message}`;
    }
  });
}

function setupGoalFeature() {
  pels.goalRunBtn.addEventListener('click', async () => {
    const targetAmount = parseFloat(pels.goalTarget.value);
    if (!targetAmount) { pels.goalResultText.textContent = 'Enter a target amount first.'; return; }
    const goal = { targetAmount };
    if (pels.goalMonths.value) goal.timeframeMonths = parseFloat(pels.goalMonths.value);
    else if (pels.goalMonthly.value) goal.monthlyContribution = parseFloat(pels.goalMonthly.value);
    if (pels.goalMonthly.value) {
      const m = parseFloat(pels.goalMonthly.value);
      goal.compareContributions = [Math.max(m - 10000, 1000), m, m + 10000];
    }

    try {
      const res = await fetch('/api/personal/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...personalProfilePayload(), goal }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const r = data.result;
      if (r.monthsToReach != null) {
        pels.goalResultText.textContent = `Saving ${pFmtMoney(r.monthlyContribution)}/month, you'd reach ${pFmtMoney(r.targetAmount)} in about ${r.yearsToReach} years (${r.monthsToReach} months).`;
      } else if (r.requiredMonthlyContribution != null) {
        pels.goalResultText.textContent = `To reach ${pFmtMoney(r.targetAmount)} in ${r.timeframeMonths} months you'd need to save ${pFmtMoney(r.requiredMonthlyContribution)}/month — ${r.affordable ? 'within' : 'above'} your current surplus of ${pFmtMoney(r.currentSurplus)}.`;
      }
      if (r.comparisons) {
        let html = '<table class="compare-table"><thead><tr><th>Monthly saving</th><th>Time to reach goal</th></tr></thead><tbody>';
        for (const c of r.comparisons) {
          html += `<tr><td>${pFmtMoney(c.monthlyContribution)}</td><td>${c.monthsToReach != null ? `${(c.monthsToReach / 12).toFixed(1)} years` : 'Not reachable within 60 years'}</td></tr>`;
        }
        html += '</tbody></table>';
        pels.goalCompareTable.innerHTML = html;
      }
    } catch (err) {
      pels.goalResultText.textContent = `Error: ${err.message}`;
    }
  });
}

function setupStressFeature() {
  pels.stressRunBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/personal/stress-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...personalProfilePayload(), shocks: [] }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const mc = data.monteCarlo;
      renderMonteCarloFanChart('personalStressChart', mc, '₹');
      const p = mc.survivalProbability;
      pels.stressExplainer.innerHTML =
        `We ran your household's 12-month cash position <strong>${mc.trials}</strong> times with realistic swings in income, expenses, and a chance of one unexpected cost. ` +
        `<strong>${p.toFixed(0)}%</strong> of those runs stayed cash-positive throughout. Typical (median) ending cash: ${pFmtMoney(mc.endCash.p50)}. ` +
        `Investment-return assumptions here are illustrative, not guaranteed.`;
    } catch (err) {
      pels.stressExplainer.textContent = `Error: ${err.message}`;
    }
  });
}

// ---------------------------------------------------------------------------
// Ask Your Personal Financial Controller
// ---------------------------------------------------------------------------
function renderPersonalAskData(intentType, data) {
  if (!data) return '';
  if (intentType === 'afford_house' || intentType === 'afford_purchase') return renderAffordComparisonTable(data);
  if (intentType === 'buy_vs_rent') {
    let html = '<table class="compare-table"><thead><tr><th>Year</th><th>Net worth (BUY)</th><th>Net worth (RENT)</th></tr></thead><tbody>';
    for (const c of data.checkpoints) html += `<tr><td>${c.years}</td><td>${pFmtMoney(c.netWorthBuy)}</td><td>${pFmtMoney(c.netWorthRent)}</td></tr>`;
    return html + '</tbody></table>';
  }
  if (intentType === 'safe_emi') {
    return `<div class="safe-limits-grid"><div class="safe-limit-card"><span class="safe-limit-label">Max safe EMI</span><span class="safe-limit-value">${pFmtMoney(data.maxSafeEmi)}/mo</span></div></div>`;
  }
  if (intentType === 'rental_yield') {
    let html = '<table class="compare-table"><thead><tr><th>Target yield</th><th>Required rent</th><th>Net yield</th></tr></thead><tbody>';
    for (const t of data.targets) html += `<tr><td>${t.targetYieldPct}%</td><td>${pFmtMoney(t.requiredRent)}</td><td>${t.netYieldPct}%</td></tr>`;
    return html + '</tbody></table>';
  }
  if (intentType === 'goal' && data.monthsToReach != null) {
    return `<p class="engine-note">Reaches goal in ${data.yearsToReach} years at ${pFmtMoney(data.monthlyContribution)}/month.</p>`;
  }
  if (intentType === 'emergency_fund') {
    return `<div class="safe-limits-grid"><div class="safe-limit-card"><span class="safe-limit-label">Target (${data.targetMonths}mo)</span><span class="safe-limit-value">${pFmtMoney(data.target)}</span></div><div class="safe-limit-card"><span class="safe-limit-label">Current</span><span class="safe-limit-value">${pFmtMoney(data.current)}</span></div></div>`;
  }
  return '';
}

function setupPersonalAsk() {
  pels.personalAskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = pels.personalAskInput.value.trim();
    if (!question) return;
    pels.personalAskSubmit.disabled = true;

    try {
      const res = await fetch('/api/personal/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, ...personalProfilePayload(), context: state.personalContext }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      state.personalContext = { ...state.personalContext, ...(data.context || {}) };
      pels.personalAskResult.classList.remove('hidden');
      pels.personalAskBadge.textContent = data.intentType.toUpperCase().replace(/_/g, ' ');
      pels.personalAskExplanation.textContent = data.explanation;
      pels.personalAskDataView.innerHTML = renderPersonalAskData(data.intentType, data.data);
      pels.personalLlmTag.textContent = describeProvider(data.provider);
    } catch (err) {
      pels.personalAskResult.classList.remove('hidden');
      pels.personalAskBadge.textContent = 'ERROR';
      pels.personalAskExplanation.textContent = err.message;
      pels.personalAskDataView.innerHTML = '';
    } finally {
      pels.personalAskSubmit.disabled = false;
    }
  });

  pels.personalExampleChips.addEventListener('click', (e) => {
    if (e.target.matches('.chip')) {
      pels.personalAskInput.value = e.target.dataset.q;
      pels.personalAskForm.dispatchEvent(new Event('submit'));
    }
  });
}

// Voice input — reuses the exact same browser SpeechRecognition API as
// Business Mode's setupVoiceInput(), pointed at the Personal console
// instead. No new voice architecture, per the spec.
function setupPersonalVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    pels.personalMicBtn.disabled = true;
    pels.personalMicBtn.title = 'Voice input not supported in this browser';
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-IN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  pels.personalMicBtn.addEventListener('click', () => {
    if (pels.personalMicBtn.classList.contains('recording')) {
      recognition.stop();
      return;
    }
    pels.personalMicBtn.classList.add('recording');
    try { recognition.start(); } catch (err) { /* already started */ }
  });

  recognition.addEventListener('result', (e) => {
    const transcript = e.results[0][0].transcript;
    pels.personalAskInput.value = transcript;
    pels.personalMicBtn.classList.remove('recording');
    pels.personalAskForm.dispatchEvent(new Event('submit'));
  });
  recognition.addEventListener('end', () => pels.personalMicBtn.classList.remove('recording'));
  recognition.addEventListener('error', () => pels.personalMicBtn.classList.remove('recording'));
}

init();