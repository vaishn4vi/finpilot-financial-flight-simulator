require('dotenv').config();
const express = require('express');
const path = require('path');

const engine = require('./engine');
const agent = require('./agent');
const { getProfile, listProfiles } = require('./profiles');

const personalEngine = require('./personalEngine');
const personalAgent = require('./personalAgent');
const { getPersonalProfile, listPersonalProfiles, defaultPersonalProfile } = require('./personalProfiles');

const app = express();
app.use(express.json());

// Serve the static frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// --- Live "adjust your business" overrides ---------------------------------
// Lets the frontend sliders (income, fixed costs, payroll, growth rate)
// override a profile's baseline numbers for ANY endpoint below, without
// touching engine.js — this just changes which numbers go IN to the same
// deterministic simulate() call. Only whitelisted numeric fields are
// accepted; anything else on the profile (currency, avgMonthlySalary,
// customerConcentration, etc.) stays as the mock profile defines it.
const OVERRIDABLE_FIELDS = ['monthlyRevenue', 'monthlyFixedCosts', 'monthlyPayroll', 'growthRate'];

function applyOverrides(profile, overrides) {
  if (!overrides) return profile;
  const merged = { ...profile };
  for (const key of OVERRIDABLE_FIELDS) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      merged[key] = value;
    }
  }
  // growthRate can legitimately be negative (shrinking revenue), so allow it
  // through even when < 0, as long as it's a finite number.
  if (typeof overrides.growthRate === 'number' && Number.isFinite(overrides.growthRate)) {
    merged.growthRate = overrides.growthRate;
  }
  return merged;
}

function parseOverridesFromQuery(query) {
  const overrides = {};
  for (const key of OVERRIDABLE_FIELDS) {
    if (query[key] !== undefined) {
      const num = parseFloat(query[key]);
      if (Number.isFinite(num)) overrides[key] = num;
    }
  }
  return Object.keys(overrides).length ? overrides : null;
}

// --- API: list available mock business profiles ---------------------------
app.get('/api/profiles', (req, res) => {
  res.json({ profiles: listProfiles() });
});

// --- API: baseline (no what-if) trajectory for a profile -------------------
// Accepts optional ?monthlyRevenue=&monthlyFixedCosts=&monthlyPayroll=&growthRate=
// query params so the frontend sliders can live-preview an adjusted business
// without needing a POST body.
app.get('/api/baseline/:profileId', (req, res) => {
  const baseProfile = getProfile(req.params.profileId);
  if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });

  const overrides = parseOverridesFromQuery(req.query);
  const profile = applyOverrides(baseProfile, overrides);

  const result = engine.simulate(profile, []);
  const baseline = engine.baselineRunway(profile);
  res.json({ profile, result, baselineRunwayMonths: baseline.runwayMonths, isProfitable: !!baseline.isProfitable });
});

// --- API: main "what if" endpoint ------------------------------------------
// 1. agent.parseIntent()      -> structured intent(s) from free text (LLM optional)
//                                 - a compound question ("hire 10 AND customer
//                                   pays late") yields multiple intents (FEATURE 3)
//                                 - a boundary question ("how many can I afford")
//                                   ALSO triggers a breakeven computation (FEATURE 2)
// 2. agent.buildScenarios()   -> 2-3 named branches, each a shocks[] array
//                                 (merged across intents for compound questions)
// 3. engine.simulate()        -> REAL math for every branch (no LLM involved)
// 4. agent.pickRecommendation() + explanation -> plain language on TOP of computed numbers
app.post('/api/whatif', async (req, res) => {
  try {
    const { profileId, question, overrides } = req.body;
    const baseProfile = getProfile(profileId);
    if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });
    if (!question || !question.trim()) return res.status(400).json({ error: 'Question is required' });
    const profile = applyOverrides(baseProfile, overrides);

    const { intents, providerUsed: parseProvider } = await agent.parseIntent(question, profile);
    const scenarioDefs = agent.buildScenarios(intents, profile);

    const scenarioResults = scenarioDefs.map((sc) => {
      const shocks = agent.materializeCostAdjustments(sc, profile);
      const result = engine.simulate(profile, shocks);
      return { name: sc.name, description: sc.description, isCompound: !!sc.isCompound, result };
    });

    const baselineResult = engine.simulate(profile, []); // for chart comparison
    const recommended = agent.pickRecommendation(scenarioResults);

    const { explanation, providerUsed: explanationProvider } = await agent.getExplanation(
      recommended,
      scenarioResults,
      profile
    );

    // Report whichever provider actually produced a result. If the configured
    // provider failed at every step, this correctly reports 'rule-based' even
    // though an LLM was configured — never claim credit the LLM didn't earn.
    const provider = parseProvider !== 'rule-based' ? parseProvider
      : explanationProvider !== 'rule-based' ? explanationProvider
      : 'rule-based';

    // FEATURE 2 — Break-even / safe-zone finder: if the question itself is a
    // boundary question ("how many employees can I afford?"), compute the
    // safe threshold IN ADDITION TO the standard branching scenarios above,
    // so the response has both the normal comparison AND a direct answer to
    // "what's the most I can do safely".
    let breakeven = null;
    const breakevenIntent = agent.detectBreakevenIntent(question);
    if (breakevenIntent) {
      const targetMinRunwayMonths = breakevenIntent.targetMinRunwayMonths || undefined;
      const thresholdResult = engine.findSafeThreshold(profile, breakevenIntent.shockType, targetMinRunwayMonths);
      breakeven = { shockType: breakevenIntent.shockType, ...thresholdResult };
    }

    res.json({
      intents,
      profile,
      baseline: baselineResult,
      scenarios: scenarioResults,
      recommendedName: recommended.name,
      explanation,
      provider,
      providerModel: provider === 'ollama' ? agent.ollamaModel() : null,
      breakeven,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Simulation failed', detail: err.message });
  }
});

// --- API: FEATURE 1 — sensitivity analysis ---------------------------------
// "What moves this outcome the most" for the RECOMMENDED scenario of a given
// what-if question. Re-uses the exact same parse -> build -> simulate ->
// recommend pipeline as /api/whatif, then hands the recommended scenario's
// materialized shocks to engine.sensitivityAnalysis() for perturbation.
app.post('/api/sensitivity', async (req, res) => {
  try {
    const { profileId, question, overrides } = req.body;
    const baseProfile = getProfile(profileId);
    if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });
    if (!question || !question.trim()) return res.status(400).json({ error: 'Question is required' });
    const profile = applyOverrides(baseProfile, overrides);

    const { intents } = await agent.parseIntent(question, profile);
    const scenarioDefs = agent.buildScenarios(intents, profile);

    const scenarioResults = scenarioDefs.map((sc) => {
      const shocks = agent.materializeCostAdjustments(sc, profile);
      const result = engine.simulate(profile, shocks);
      return { name: sc.name, description: sc.description, shocks, result };
    });

    const recommended = agent.pickRecommendation(scenarioResults);
    const sensitivity = engine.sensitivityAnalysis(profile, recommended.shocks);

    res.json({
      recommendedName: recommended.name,
      sensitivity,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sensitivity analysis failed', detail: err.message });
  }
});

// --- API: FEATURE 2 — break-even / safe-zone finder (standalone) ----------
// Direct endpoint for a known shockType, independent of any parsed question —
// e.g. for a frontend control that lets a user pick "hire" or "revenue_shock"
// explicitly rather than typing a boundary question.
app.post('/api/breakeven', (req, res) => {
  try {
    const { profileId, shockType, targetMinRunwayMonths, overrides } = req.body;
    const baseProfile = getProfile(profileId);
    if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });
    if (!['hire', 'revenue_shock'].includes(shockType)) {
      return res.status(400).json({ error: 'shockType must be "hire" or "revenue_shock"' });
    }
    const profile = applyOverrides(baseProfile, overrides);

    const thresholdResult = engine.findSafeThreshold(profile, shockType, targetMinRunwayMonths || undefined);
    res.json({ shockType, ...thresholdResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Breakeven computation failed', detail: err.message });
  }
});

// --- API: "WHAT SHOULD I DO?" decision mode ---------------------------------
// Given the business's current numbers (profile + live overrides), generate
// a fixed family of deterministic turnaround levers (cost cuts, hiring
// freeze, pricing, sales investment, combination), simulate EVERY one of
// them through the exact same engine.simulate() used everywhere else, rank
// them with the same policy as /api/whatif, and explain the winner. No
// free-text parsing involved — the input is the business's own numbers.
app.post('/api/decide', async (req, res) => {
  try {
    const { profileId, overrides } = req.body;
    const baseProfile = getProfile(profileId);
    if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });
    const profile = applyOverrides(baseProfile, overrides);

    const strategyDefs = agent.buildDecisionStrategies(profile);
    const scenarioResults = strategyDefs.map((sc) => {
      const shocks = agent.materializeCostAdjustments(sc, profile);
      const result = engine.simulate(profile, shocks);
      return { name: sc.name, description: sc.description, result };
    });

    const recommended = agent.pickRecommendation(scenarioResults);
    const { explanation, providerUsed } = await agent.getExplanation(recommended, scenarioResults, profile);

    res.json({
      profile,
      scenarios: scenarioResults,
      recommendedName: recommended.name,
      explanation,
      provider: providerUsed,
      providerModel: providerUsed === 'ollama' ? agent.ollamaModel() : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Decision analysis failed', detail: err.message });
  }
});

// --- API: SAFE LIMITS — combined, always-on reverse-simulation summary -----
// Runs findSafeThreshold() for both hiring headcount and revenue-drop
// tolerance in one call, so the UI can show a persistent "Safe Limit" card
// without the user having to phrase a boundary question in free text.
app.get('/api/safe-limits/:profileId', (req, res) => {
  try {
    const baseProfile = getProfile(req.params.profileId);
    if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });
    const overrides = parseOverridesFromQuery(req.query);
    const profile = applyOverrides(baseProfile, overrides);
    const targetMinRunwayMonths = req.query.targetMinRunwayMonths
      ? parseInt(req.query.targetMinRunwayMonths, 10)
      : undefined;

    const maxHiring = engine.findSafeThreshold(profile, 'hire', targetMinRunwayMonths);
    const maxRevenueDrop = engine.findSafeThreshold(profile, 'revenue_shock', targetMinRunwayMonths);

    res.json({
      profile,
      targetMinRunwayMonths: maxHiring.targetMinRunwayMonths,
      maxHiring,
      maxRevenueDrop,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Safe-limit computation failed', detail: err.message });
  }
});

// --- API: FINANCIAL RISK RADAR — always-on proactive risk detection --------
// Same "always-on, no question needed" pattern as /api/safe-limits and
// /api/montecarlo/:profileId: accepts the same live-slider overrides, runs
// engine.analyzeRisks() (100% deterministic — see engine.js), then asks
// agent.buildProtectiveActions() which of the existing scenario levers are
// relevant to the CURRENT medium/high risks. Every one of those candidate
// actions is simulated here, through the exact same engine.simulate() used
// by every other endpoint, so "Protect My Business" never shows a number
// that didn't come out of the deterministic engine.
app.get('/api/risk-radar/:profileId', (req, res) => {
  try {
    const baseProfile = getProfile(req.params.profileId);
    if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });
    const overrides = parseOverridesFromQuery(req.query);
    const profile = applyOverrides(baseProfile, overrides);

    const { financialHealth, risks } = engine.analyzeRisks(profile);

    const baselineResult = engine.simulate(profile, []);
    const baselineRunway = engine.baselineRunway(profile);
    const baselineRunwayMonths = baselineRunway.isProfitable ? null : round2Safe(baselineRunway.runwayMonths);

    const actionDefs = agent.buildProtectiveActions(profile, risks);
    const protectiveActions = actionDefs.map((action) => {
      const shocks = agent.materializeCostAdjustments(action, profile);
      const result = engine.simulate(profile, shocks);
      const minCashDelta = round2Safe(result.summary.minCash - baselineResult.summary.minCash);
      const endCashDelta = round2Safe(result.summary.endCash - baselineResult.summary.endCash);
      return {
        forRisk: action.forRisk,
        name: action.name,
        description: action.description,
        simulateQuestion: action.simulateQuestion,
        expectedImpact: {
          minCashDelta,
          endCashDelta,
          currency: profile.currency,
        },
      };
    });

    res.json({
      profile,
      financialHealth,
      risks,
      baseline: { minCash: baselineResult.summary.minCash, endCash: baselineResult.summary.endCash, runwayMonths: baselineRunwayMonths },
      protectiveActions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Risk Radar computation failed', detail: err.message });
  }
});

function round2Safe(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

// --- API: FEATURE 3 — Monte Carlo stress test (baseline / current numbers) --
// Always-on, no question needed: how confident should you be in the CURRENT
// baseline forecast (profile defaults or live slider overrides)? Runs the
// baseline (zero what-if shocks) through engine.monteCarloSimulate() so the
// dashboard can show a probability band alongside the single deterministic
// "Revenue vs Costs" line.
app.get('/api/montecarlo/:profileId', (req, res) => {
  try {
    const baseProfile = getProfile(req.params.profileId);
    if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });
    const overrides = parseOverridesFromQuery(req.query);
    const profile = applyOverrides(baseProfile, overrides);
    const trials = req.query.trials ? parseInt(req.query.trials, 10) : undefined;

    const monteCarlo = engine.monteCarloSimulate(profile, [], trials ? { trials } : {});
    res.json({ profile, monteCarlo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Monte Carlo simulation failed', detail: err.message });
  }
});

// --- API: FEATURE 3b — Monte Carlo for the RECOMMENDED scenario -------------
// Same parse -> build -> simulate -> recommend pipeline as /api/sensitivity
// (mode: 'whatif', the default) or /api/decide (mode: 'decide'), then
// stress-tests the RECOMMENDED scenario's shocks under realistic uncertainty
// instead of just perturbing one variable at a time. Answers "given
// everything else that could plausibly happen too, how solid is this
// recommendation really?" — a natural companion to sensitivity analysis
// (which finds what matters most) rather than a replacement for it.
app.post('/api/montecarlo', async (req, res) => {
  try {
    const { profileId, question, overrides, trials, mode } = req.body;
    const baseProfile = getProfile(profileId);
    if (!baseProfile) return res.status(404).json({ error: 'Unknown profile' });
    const profile = applyOverrides(baseProfile, overrides);

    let scenarioDefs;
    if (mode === 'decide') {
      scenarioDefs = agent.buildDecisionStrategies(profile);
    } else {
      if (!question || !question.trim()) return res.status(400).json({ error: 'Question is required' });
      const { intents } = await agent.parseIntent(question, profile);
      scenarioDefs = agent.buildScenarios(intents, profile);
    }

    const scenarioResults = scenarioDefs.map((sc) => {
      const shocks = agent.materializeCostAdjustments(sc, profile);
      const result = engine.simulate(profile, shocks);
      return { name: sc.name, description: sc.description, shocks, result };
    });

    const recommended = agent.pickRecommendation(scenarioResults);
    const monteCarlo = engine.monteCarloSimulate(profile, recommended.shocks, trials ? { trials } : {});

    res.json({ recommendedName: recommended.name, monteCarlo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Monte Carlo simulation failed', detail: err.message });
  }
});

// --- API: FINANCIAL DOCUMENT INPUT (MVP) ------------------------------------
// Accepts raw text (pasted, or read client-side from a CSV/plain-text file
// via FileReader — no file upload middleware needed for this MVP) and
// extracts a structured set of financial figures using labeled-number
// heuristics. This is intentionally a light, auditable regex extractor —
// NOT an LLM — so a wrong figure is a debuggable pattern-match miss, not a
// hallucination. The extracted numbers become `overrides` for the existing
// simulation engine; the engine still does 100% of the actual math.
// Each pattern captures group 1 = the number, group 2 = an optional
// lakh/crore/k/m suffix immediately after it (e.g. "₹18.4L", "7.2 lakh").
const NUM = '(-?[\\d,]+\\.?\\d*)\\s*(l|lakh|lakhs|cr|crore|crores|k|m)?';
// The gap between the label and the number can contain a colon, currency
// symbol, or spaces — anything except another digit (which would mean we
// walked into a different number entirely).
const GAP = '[^\\d]{0,12}';
const EXTRACT_PATTERNS = [
  { field: 'monthlyRevenue', patterns: [new RegExp(`revenue${GAP}${NUM}`, 'i'), new RegExp(`sales${GAP}${NUM}`, 'i')] },
  { field: 'startingCash', patterns: [new RegExp(`cash(?: balance| on hand| in bank)?${GAP}${NUM}`, 'i'), new RegExp(`bank balance${GAP}${NUM}`, 'i')] },
  { field: 'monthlyPayroll', patterns: [new RegExp(`payroll${GAP}${NUM}`, 'i'), new RegExp(`salaries${GAP}${NUM}`, 'i')] },
  { field: 'monthlyFixedCosts', patterns: [new RegExp(`(?:operating costs|fixed costs|opex|expenses)${GAP}${NUM}`, 'i')] },
  { field: 'receivables', patterns: [new RegExp(`receivables${GAP}${NUM}`, 'i')] },
];

// Numbers may be written with a lakh/crore suffix (₹18.4L, ₹1.5Cr) or "k"/"m" —
// normalize those into raw rupee/unit amounts before returning.
function parseIndianNumber(raw, suffix) {
  let n = parseFloat(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const s = (suffix || '').toLowerCase();
  if (s === 'l' || s === 'lakh' || s === 'lakhs') n *= 100000;
  else if (s === 'cr' || s === 'crore' || s === 'crores') n *= 10000000;
  else if (s === 'k') n *= 1000;
  else if (s === 'm') n *= 1000000;
  return Math.round(n * 100) / 100;
}

app.post('/api/extract', (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

    const extracted = {};
    const notes = [];

    for (const { field, patterns } of EXTRACT_PATTERNS) {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          const value = parseIndianNumber(match[1], match[2]);
          if (value !== null) {
            extracted[field] = value;
            break;
          }
        }
      }
    }

    if (Object.keys(extracted).length === 0) {
      notes.push('No recognizable financial figures found — try a clearer label like "Revenue: ₹18.4L" per line.');
    }

    res.json({ extracted, notes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Document extraction failed', detail: err.message });
  }
});

// --- API: SHAREABLE SCENARIOS ------------------------------------------------
// In-memory store (resets on server restart — fine for a hackathon demo; a
// production version would use a real datastore). Stores the full response
// of a /api/whatif or /api/decide call so it can be reopened via a short ID.
const sharedScenarios = new Map();
let shareCounter = 0;

app.post('/api/share', (req, res) => {
  const { payload } = req.body;
  if (!payload) return res.status(400).json({ error: 'payload is required' });
  shareCounter += 1;
  const id = shareCounter.toString(36) + Date.now().toString(36).slice(-4);
  sharedScenarios.set(id, { payload, createdAt: new Date().toISOString() });
  res.json({ id });
});

app.get('/api/share/:id', (req, res) => {
  const entry = sharedScenarios.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Shared scenario not found (or server has restarted)' });
  res.json(entry);
});

// =============================================================================
// PERSONAL MODE — "Can I safely make this life decision?"
// =============================================================================
// Every route below is a thin HTTP wrapper around personalEngine.js, which
// itself is a thin wrapper around engine.simulate()/monteCarloSimulate().
// No cash-flow math is re-derived here or in personalEngine.js — see the
// header comment in personalEngine.js for the full mapping.

function resolvePersonalProfile(body) {
  if (body && body.profile && typeof body.profile === 'object' && body.profile.income) {
    return body.profile; // a full custom profile from the Personal Profile form
  }
  const id = (body && body.profileId) || 'demo_household';
  return getPersonalProfile(id) || defaultPersonalProfile();
}

// Applies inline figures parsed straight out of a free-text question
// ("I earn 1.5L, have 12L savings...") on TOP of the base profile, for that
// one request only — mirrors applyOverrides() above, same idea, personal
// domain fields instead of business ones.
function applyPersonalOverrides(profile, assumptions = {}) {
  const merged = JSON.parse(JSON.stringify(profile));
  if (typeof assumptions.monthlyIncome === 'number') merged.income = { ...merged.income, monthly: assumptions.monthlyIncome };
  if (typeof assumptions.savings === 'number') merged.savings = { ...merged.savings, current: assumptions.savings };
  if (typeof assumptions.rent === 'number') merged.expenses = { ...merged.expenses, rent: assumptions.rent };
  if (typeof assumptions.emi === 'number') merged.debt = { ...merged.debt, existingEMI: assumptions.emi };
  return merged;
}

app.get('/api/personal/profiles', (req, res) => {
  res.json({ profiles: listPersonalProfiles(), default: defaultPersonalProfile() });
});

app.get('/api/personal/profile/:id', (req, res) => {
  const profile = getPersonalProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Unknown personal profile' });
  res.json({ profile });
});

// --- Snapshot + Financial Health (always-on, no question needed) ------------
app.post('/api/personal/health', (req, res) => {
  try {
    const profile = resolvePersonalProfile(req.body);
    const base = personalEngine.mapProfileToBase(profile);
    const health = personalEngine.personalHealthScore(profile);
    res.json({
      profile,
      snapshot: {
        monthlyIncome: personalEngine.totalMonthlyIncome(profile),
        monthlyExpenses: personalEngine.totalMonthlyExpenses(profile),
        monthlySurplus: personalEngine.monthlySurplus(profile),
        savings: (profile.savings && profile.savings.current) || 0,
        investments: (profile.savings && profile.savings.investments) || 0,
        emergencyFund: (profile.savings && profile.savings.emergencyFund) || 0,
        existingEMI: (profile.debt && profile.debt.existingEMI) || 0,
        currency: base.currency,
      },
      health,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Personal health computation failed', detail: err.message });
  }
});

// --- FEATURE: CAN I AFFORD THIS? --------------------------------------------
app.post('/api/personal/afford', (req, res) => {
  try {
    const baseProfile = resolvePersonalProfile(req.body);
    const { price, assumptions } = req.body;
    if (!price) return res.status(400).json({ error: 'price is required' });
    const profile = applyPersonalOverrides(baseProfile, req.body.overrides || {});
    const result = personalEngine.simulateAffordability(profile, { price, ...(assumptions || {}) });
    res.json({ profile, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Affordability simulation failed', detail: err.message });
  }
});

// --- FEATURE: MAXIMUM SAFE EMI (reverse simulation) -------------------------
app.post('/api/personal/safe-emi', (req, res) => {
  try {
    const baseProfile = resolvePersonalProfile(req.body);
    const profile = applyPersonalOverrides(baseProfile, req.body.overrides || {});
    const opts = {
      emergencyFundTargetMonths: req.body.emergencyFundTargetMonths || profile.minEmergencyFundTarget,
      desiredMonthlySavings: req.body.desiredMonthlySavings != null ? req.body.desiredMonthlySavings : profile.desiredMonthlySavings,
    };
    const result = personalEngine.findMaxSafeEmi(profile, opts);
    // impliedMaxLoan is returned as a function by the engine (kept generic
    // over rate/tenure) — resolve it here to a concrete number for the API.
    const rate = (req.body.interestRatePct) || personalEngine.DEFAULT_ASSUMPTIONS.interestRatePct;
    const tenure = (req.body.tenureYears) || personalEngine.DEFAULT_ASSUMPTIONS.tenureYears;
    const impliedMaxLoan = result.impliedMaxLoan ? result.impliedMaxLoan(rate, tenure) : null;
    res.json({ profile, result: { ...result, impliedMaxLoan, atInterestRatePct: rate, atTenureYears: tenure } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Safe EMI computation failed', detail: err.message });
  }
});

// --- FEATURE: BUY VS RENT ----------------------------------------------------
app.post('/api/personal/buy-vs-rent', (req, res) => {
  try {
    const baseProfile = resolvePersonalProfile(req.body);
    const profile = applyPersonalOverrides(baseProfile, req.body.overrides || {});
    const { price, currentRent, ...params } = req.body;
    if (!price) return res.status(400).json({ error: 'price is required' });
    const result = personalEngine.buyVsRent(profile, { price, currentRent, ...params });
    res.json({ profile, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Buy-vs-rent simulation failed', detail: err.message });
  }
});

// --- FEATURE: RENTAL YIELD ADVISOR ------------------------------------------
app.post('/api/personal/rental-yield', (req, res) => {
  try {
    const { price } = req.body;
    if (!price) return res.status(400).json({ error: 'price is required' });
    const result = personalEngine.rentalYieldAnalysis(req.body);
    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Rental yield analysis failed', detail: err.message });
  }
});

// --- FEATURE: FINANCIAL GOALS ------------------------------------------------
app.post('/api/personal/goal', (req, res) => {
  try {
    const baseProfile = resolvePersonalProfile(req.body);
    const profile = applyPersonalOverrides(baseProfile, req.body.overrides || {});
    const { goal } = req.body;
    if (!goal || !goal.targetAmount) return res.status(400).json({ error: 'goal.targetAmount is required' });
    const result = personalEngine.goalProjection(profile, goal);
    res.json({ profile, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Goal projection failed', detail: err.message });
  }
});

// --- FEATURE: PERSONAL STRESS TEST (Monte Carlo) ----------------------------
app.post('/api/personal/stress-test', (req, res) => {
  try {
    const baseProfile = resolvePersonalProfile(req.body);
    const profile = applyPersonalOverrides(baseProfile, req.body.overrides || {});
    const shocks = Array.isArray(req.body.shocks) ? req.body.shocks : [];
    const { base, monteCarlo } = personalEngine.personalStressTest(profile, shocks, req.body.config || {});
    res.json({ profile, base, monteCarlo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Personal stress test failed', detail: err.message });
  }
});

// --- STRUCTURED-INPUT FALLBACK FOR A PROPERTY LISTING -----------------------
// Reliable image/vision extraction is out of scope for this pass (see
// README) — this is the "clean structured-input fallback" the spec asks
// for instead: paste the listing text, get back structured fields. Same
// auditable-regex philosophy as the Business Mode /api/extract endpoint;
// never fabricates a value it didn't find in the text.
const PROPERTY_NUM = '(-?[\\d,]+\\.?\\d*)\\s*(l|lakh|lakhs|cr|crore|crores|k|m)?\\b';
const PROPERTY_GAP = '[^\\d]{0,15}';
const PROPERTY_PATTERNS = [
  { field: 'price', patterns: [new RegExp(`(?:₹|rs\\.?|price)${PROPERTY_GAP}${PROPERTY_NUM}`, 'i')] },
  { field: 'areaSqft', patterns: [new RegExp(`(\\d[\\d,]*)\\s*(?:sq\\s*\\.?\\s*ft|sqft|square feet)`, 'i')] },
  { field: 'rent', patterns: [new RegExp(`rent${PROPERTY_GAP}${PROPERTY_NUM}`, 'i')] },
  { field: 'monthlyMaintenance', patterns: [new RegExp(`maintenance${PROPERTY_GAP}${PROPERTY_NUM}`, 'i')] },
];

app.post('/api/personal/extract-listing', (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

    const extracted = {};
    const notes = [];
    for (const { field, patterns } of PROPERTY_PATTERNS) {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          if (field === 'areaSqft') {
            extracted[field] = parseFloat(match[1].replace(/,/g, ''));
          } else {
            const value = personalAgent.parseIndianNumber(match[1], match[2]);
            if (value !== null) extracted[field] = value;
          }
          break;
        }
      }
    }
    const bhkMatch = text.match(/(\d)\s*bhk/i);
    if (bhkMatch) extracted.bhk = parseInt(bhkMatch[1], 10);

    if (Object.keys(extracted).length === 0) {
      notes.push('No recognizable property figures found — try a clearer format like "2BHK ₹75 lakh, 1100 sq ft, rent ₹28,000".');
    }
    res.json({ extracted, notes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Listing extraction failed', detail: err.message });
  }
});

// --- ASK YOUR PERSONAL FINANCIAL CONTROLLER ---------------------------------
// The Personal Mode equivalent of /api/whatif: free text in, one of the
// deterministic features above run, plain-language explanation out. Uses
// personalAgent ONLY to (a) classify which feature applies and (b) pull
// numbers already present in the sentence — every number in the response
// still comes from personalEngine.js.
app.post('/api/personal/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });

    const baseProfile = resolvePersonalProfile(req.body);
    const parsed = await personalAgent.parseQuestion(question);
    // Carry forward numbers mentioned in EARLIER turns of the same session
    // (e.g. the property price from "can I afford a 70L house?") so a
    // follow-up like "what about renting instead?" doesn't have to restate
    // them. Freshly-parsed numbers from THIS question always take priority.
    const context = req.body.context && typeof req.body.context === 'object' ? req.body.context : {};
    const a = { ...context, ...parsed.assumptions };
    const profile = applyPersonalOverrides(baseProfile, a);
    const intentTypes = parsed.intents.map((i) => i.type);
    const primary = intentTypes[0] || 'unknown';

    const respond = (intentType, data, explanation) =>
      res.json({ intentType, intents: intentTypes, assumptions: a, context: a, provider: parsed.providerUsed, profile, data, explanation });

    if (primary === 'afford_house' || primary === 'afford_purchase') {
      const price = a.price;
      if (!price) {
        return respond('needs_price', null, 'I can run the affordability analysis as soon as I know the price — try including it, e.g. "a ₹70 lakh house".');
      }
      let effectiveProfile = profile;
      // Compound: "...and my income drops 15%" -> apply the income shock to
      // the effective profile BEFORE running the same three-branch analysis.
      if (intentTypes.includes('income_shock') && a.pctChange) {
        effectiveProfile = JSON.parse(JSON.stringify(profile));
        effectiveProfile.income.monthly = round2(effectiveProfile.income.monthly * (1 - a.pctChange));
        effectiveProfile.income.other = round2(effectiveProfile.income.other * (1 - a.pctChange));
      }
      const result = personalEngine.simulateAffordability(effectiveProfile, { price });
      return respond('afford_house', result, result.why);
    }

    if (primary === 'buy_vs_rent') {
      const price = a.price;
      const currentRent = a.rent || (profile.expenses && profile.expenses.rent);
      if (!price || !currentRent) {
        return respond('needs_price_and_rent', null, 'To compare buying vs. renting I need both the property price and the rent you would otherwise pay.');
      }
      const result = personalEngine.buyVsRent(profile, { price, currentRent });
      return respond('buy_vs_rent', result, result.verdict);
    }

    if (primary === 'safe_emi') {
      const result = personalEngine.findMaxSafeEmi(profile, {
        emergencyFundTargetMonths: profile.minEmergencyFundTarget,
        desiredMonthlySavings: profile.desiredMonthlySavings,
      });
      const explanation = result.note
        ? result.note
        : `Based on your current surplus and emergency-fund target, ${result.maxSafeEmi.toLocaleString('en-IN')}/month is the most you could commit to a new EMI without breaching your ${result.emergencyFundTargetMonths}-month buffer.`;
      return respond('safe_emi', result, explanation);
    }

    if (primary === 'emergency_fund') {
      const expenses = personalEngine.totalMonthlyExpenses(profile) + ((profile.debt && profile.debt.existingEMI) || 0);
      const targetMonths = profile.minEmergencyFundTarget || personalEngine.DEFAULT_ASSUMPTIONS.emergencyFundTargetMonths;
      const target = round2(expenses * targetMonths);
      const current = (profile.savings && profile.savings.emergencyFund) || 0;
      const result = { targetMonths, target, current, shortfall: round2(Math.max(target - current, 0)), monthsCoveredToday: expenses > 0 ? round1(current / expenses) : null };
      return respond('emergency_fund', result, `A ${targetMonths}-month buffer at your current expenses + EMI is ${target.toLocaleString('en-IN')}. You currently have ${current.toLocaleString('en-IN')} set aside for this.`);
    }

    if (primary === 'rental_yield') {
      if (!a.price) {
        return respond('needs_property_details', null, 'To analyze rental yield I need the property price (and ideally your down payment / loan terms) — try the Rental Analyzer form for full detail.');
      }
      const result = personalEngine.rentalYieldAnalysis({ price: a.price, statedRent: a.rent || undefined });
      return respond('rental_yield', result, `For a ${a.price.toLocaleString('en-IN')} property, charging ${result.targets[1].requiredRent.toLocaleString('en-IN')}/month gets you to a 4% gross yield.`);
    }

    if (primary === 'goal') {
      if (!a.goalAmount) {
        return respond('needs_goal_amount', null, 'Tell me the target amount you want to reach, e.g. "save ₹50 lakh".');
      }
      const goal = {
        targetAmount: a.goalAmount,
        currentAmount: (profile.savings && profile.savings.current) || 0,
        monthlyContribution: profile.desiredMonthlySavings || personalEngine.monthlySurplus(profile),
      };
      const result = personalEngine.goalProjection(profile, goal);
      const explanation = result.monthsToReach != null
        ? `Saving ${goal.monthlyContribution.toLocaleString('en-IN')}/month, you'd reach ${a.goalAmount.toLocaleString('en-IN')} in about ${result.yearsToReach} years.`
        : `At ${goal.monthlyContribution.toLocaleString('en-IN')}/month this goal isn't reachable within 60 years — increase the monthly contribution.`;
      return respond('goal', result, explanation);
    }

    if (primary === 'income_shock') {
      const pct = a.pctChange || 0.2;
      const base = personalEngine.mapProfileToBase(profile);
      const shocks = [{ type: 'revenue_shock', startMonth: 1, pctChange: -pct }];
      const result = engine.simulate(base, shocks, 12);
      const newSurplus = round2(personalEngine.monthlySurplus(profile) - base.monthlyRevenue * pct);
      return respond('income_shock', { pct, result, newMonthlySurplus: newSurplus }, `A ${Math.round(pct * 100)}% income drop cuts your monthly surplus to ${newSurplus.toLocaleString('en-IN')}. ${result.summary.goesNegative ? `Your savings would run out around month ${result.summary.monthOfInsolvency}.` : 'Your savings stay positive across the next 12 months at this rate.'}`);
    }

    return respond(
      'unknown',
      null,
      "I didn't catch a specific scenario in that — try one of: \"Can I afford a ₹70L house?\", \"Should I buy or keep renting?\", \"What's my safe EMI?\", \"What happens if my income drops 20%?\", or \"How long to save ₹50L?\""
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Personal ask failed', detail: err.message });
  }
});

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Financial Flight Simulator running at http://localhost:${PORT}`);
  const provider = agent.getProvider();
  if (provider === 'none') {
    console.log('LLM provider: none — using rule-based parser/explainer (fully functional, zero network calls)');
  } else if (provider === 'anthropic') {
    console.log(`LLM provider: anthropic ${process.env.ANTHROPIC_API_KEY ? '(ANTHROPIC_API_KEY found)' : '(WARNING: ANTHROPIC_API_KEY not set — will fall back to rule-based on every request)'}`);
  } else if (provider === 'ollama') {
    console.log(`LLM provider: ollama — model "${agent.ollamaModel()}" @ http://localhost:11434 (falls back to rule-based if unreachable)`);
  }
});
