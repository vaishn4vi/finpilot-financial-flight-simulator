/**
 * engine.js — Deterministic Financial Engine
 * ---------------------------------------------------------
 * This file contains ZERO calls to any LLM. Every number produced here
 * comes from arithmetic on the input parameters. The agentic layer
 * (agent.js) is responsible for turning natural language into the
 * `shocks` array consumed by simulate(); this file just does the math.
 *
 * Model: month-by-month cash simulation over a fixed horizon.
 *   revenue(m)   = baseMonthlyRevenue * (1 + growthRate)^(m-1)
 *   costs(m)     = fixedCosts + payroll + shock-driven cost deltas
 *   netBurn(m)   = costs(m) - revenueRealized(m)
 *   cash(m)      = cash(m-1) - netBurn(m)
 *   runway       = months until cash(m) <= 0 (or > horizon => "safe")
 */

const HORIZON_MONTHS = 12;

/**
 * @param {Object} base - baseline business financials
 * @param {number} base.startingCash
 * @param {number} base.monthlyRevenue
 * @param {number} base.monthlyFixedCosts
 * @param {number} base.monthlyPayroll
 * @param {number} base.growthRate       - monthly fractional growth, e.g. 0.03 = 3%/mo
 * @param {number} base.paymentTermsDays - average customer payment terms (informational)
 * @returns {{month:number, runwayMonths:number|null}}
 */
function baselineRunway(base) {
  const netBurn = (base.monthlyFixedCosts + base.monthlyPayroll) - base.monthlyRevenue;
  if (netBurn <= 0) return { runwayMonths: null, isProfitable: true }; // not burning cash
  return { runwayMonths: base.startingCash / netBurn, isProfitable: false };
}

/**
 * Run a full 12-month simulation given a baseline and an array of shocks.
 * Shock types supported:
 *   { type: 'hire', month, count, avgMonthlySalary }
 *      -> adds count*avgMonthlySalary to payroll from `month` onward (cumulative with other hires)
 *   { type: 'revenue_shock', startMonth, pctChange }
 *      -> multiplies revenue by (1+pctChange) from startMonth onward (pctChange can be negative)
 *   { type: 'delay_payment', fromMonth, amount, delayMonths }
 *      -> removes `amount` of revenue in fromMonth, re-adds it delayMonths later
 *   { type: 'one_time_cash', month, amount }
 *      -> amount can be positive (cash in, e.g. credit line draw) or negative (cash out, e.g. loan repayment/interest)
 *
 * @param {Object} [options]
 * @param {number[]} [options.monthlyRevenueMultipliers] - optional, length===horizon.
 *   Multiplies each month's revenue independently (default 1 = no change).
 *   Used by monteCarloSimulate() below to layer independent month-to-month
 *   demand noise on top of the trend/shocks without duplicating this loop's
 *   logic — every Monte Carlo trial still runs through this exact function.
 * @returns {Object} simulation result with monthly series + summary metrics
 */
function simulate(base, shocks = [], horizon = HORIZON_MONTHS, options = {}) {
  let cash = base.startingCash;
  let cumulativeHireCost = 0;
  const deferredInflows = {}; // month -> amount arriving that month from delayed payments
  const revenueMultipliers = options.monthlyRevenueMultipliers || null;

  const months = [];

  for (let m = 1; m <= horizon; m++) {
    // 1. Revenue before shocks (organic growth curve)
    let revenue = base.monthlyRevenue * Math.pow(1 + (base.growthRate || 0), m - 1);

    // 1b. Optional independent per-month noise multiplier (Monte Carlo only;
    // undefined/omitted for every normal deterministic call in this app).
    if (revenueMultipliers && revenueMultipliers[m - 1] != null) {
      revenue *= Math.max(revenueMultipliers[m - 1], 0);
    }

    // 2. Apply revenue shocks (drops / boosts), cumulative & ongoing from startMonth
    for (const s of shocks) {
      if (s.type === 'revenue_shock' && m >= s.startMonth) {
        revenue = revenue * (1 + s.pctChange);
      }
    }

    // 3. Apply payment delays: remove amount from this month, schedule it later
    for (const s of shocks) {
      if (s.type === 'delay_payment' && m === s.fromMonth) {
        revenue -= s.amount;
        const arrivalMonth = m + s.delayMonths;
        deferredInflows[arrivalMonth] = (deferredInflows[arrivalMonth] || 0) + s.amount;
      }
    }
    const deferredInflowThisMonth = deferredInflows[m] || 0;
    const revenueRealized = revenue + deferredInflowThisMonth;

    // 4. Costs: fixed + payroll + cumulative hiring shocks
    for (const s of shocks) {
      if (s.type === 'hire' && m === s.month) {
        cumulativeHireCost += s.count * s.avgMonthlySalary;
      }
    }
    let costs = base.monthlyFixedCosts + base.monthlyPayroll + cumulativeHireCost;

    // 5. One-time cash events (credit draws, repayments, interest, etc.)
    let oneTimeCash = 0;
    for (const s of shocks) {
      if (s.type === 'one_time_cash' && s.month === m) {
        oneTimeCash += s.amount;
      }
    }

    const netBurn = costs - revenueRealized - oneTimeCash;
    cash = cash - netBurn;

    months.push({
      month: m,
      revenue: round2(revenue),
      deferredInflow: round2(deferredInflowThisMonth),
      costs: round2(costs),
      oneTimeCash: round2(oneTimeCash),
      netBurn: round2(netBurn),
      cash: round2(cash),
      risk: riskLevel(cash, costs - revenueRealized - oneTimeCash),
    });
  }

  return {
    months,
    summary: summarize(months, base),
  };
}

function riskLevel(cash, netBurn) {
  if (cash < 0) return 'critical';
  if (netBurn > 0 && cash < netBurn * 2) return 'warning'; // less than 2 months of buffer at current burn
  return 'safe';
}

function summarize(months, base) {
  const endCash = months[months.length - 1].cash;
  const minCashMonth = months.reduce((min, cur) => (cur.cash < min.cash ? cur : min), months[0]);
  const firstNegativeMonth = months.find((mo) => mo.cash < 0);
  const riskMonthCount = months.filter((mo) => mo.risk !== 'safe').length;
  const criticalMonthCount = months.filter((mo) => mo.risk === 'critical').length;

  return {
    endCash: round2(endCash),
    minCash: round2(minCashMonth.cash),
    minCashMonth: minCashMonth.month,
    goesNegative: !!firstNegativeMonth,
    monthOfInsolvency: firstNegativeMonth ? firstNegativeMonth.month : null,
    riskMonthCount,
    criticalMonthCount,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// =============================================================================
// FEATURE 1 — Sensitivity analysis ("what moves this outcome the most")
// =============================================================================
// Re-runs simulate() multiple times, each time perturbing ONE input variable
// by a fixed delta while holding everything else constant, and measures the
// resulting swing in endCash / minCash versus the unperturbed baseline. This
// never touches simulate()'s internals — it only calls simulate() repeatedly
// with different inputs, which is exactly what a human analyst would do by
// hand in a spreadsheet with "what if" toggles. Still zero LLM involvement.

const SENSITIVITY_VARIABLES = [
  {
    key: 'growthRate',
    label: 'Growth rate',
    unit: 'relative',
    deltaPct: 0.20, // ±20%
    perturb: (base, direction) => ({
      ...base,
      growthRate: (base.growthRate || 0) * (1 + direction * 0.20),
    }),
  },
  {
    key: 'monthlyFixedCosts',
    label: 'Fixed costs',
    unit: 'relative',
    deltaPct: 0.10, // ±10%
    perturb: (base, direction) => ({
      ...base,
      monthlyFixedCosts: base.monthlyFixedCosts * (1 + direction * 0.10),
    }),
  },
  {
    key: 'paymentTermsDays',
    label: 'Payment terms',
    unit: 'days',
    deltaDays: 15, // ±15 days
    // paymentTermsDays isn't itself wired into simulate()'s cash math (it's
    // informational on the profile), so we model a ±15-day swing as an
    // equivalent delay/advance of a slice of one month's revenue — the same
    // mechanism the agent already uses for "customer pays late" scenarios.
    // direction=+1 (customers pay 15 days SLOWER) -> delay_payment shock.
    // direction=-1 (customers pay 15 days FASTER) -> one_time_cash pulled forward.
    perturbShocks: (base, direction, existingShocks) => {
      const sliceFraction = 15 / 30;
      const amount = base.monthlyRevenue * sliceFraction;
      if (direction > 0) {
        return [...existingShocks, { type: 'delay_payment', fromMonth: 2, amount, delayMonths: 1 }];
      }
      return [...existingShocks, { type: 'one_time_cash', month: 2, amount }];
    },
  },
  {
    key: 'hireCost',
    label: 'Cost per hire',
    unit: 'relative',
    deltaPct: 0.10, // ±10%
    // Only meaningful if the scenario already contains at least one 'hire'
    // shock — otherwise there's no hiring cost to be sensitive to.
    applicable: (shocks) => shocks.some((s) => s.type === 'hire'),
    perturbShocks: (base, direction, existingShocks) =>
      existingShocks.map((s) =>
        s.type === 'hire' ? { ...s, avgMonthlySalary: s.avgMonthlySalary * (1 + direction * 0.10) } : s
      ),
  },
];

function sensitivityAnalysis(base, shocks = [], horizon = HORIZON_MONTHS) {
  const baselineResult = simulate(base, shocks, horizon);
  const baselineEndCash = baselineResult.summary.endCash;
  const baselineMinCash = baselineResult.summary.minCash;

  const rows = [];

  for (const variable of SENSITIVITY_VARIABLES) {
    if (variable.applicable && !variable.applicable(shocks)) {
      rows.push({
        key: variable.key,
        label: variable.label,
        applicable: false,
        note: 'Not applicable to this scenario (no matching shock present).',
      });
      continue;
    }

    const directions = [1, -1].map((direction) => {
      const perturbedBase = variable.perturb ? variable.perturb(base, direction) : base;
      const perturbedShocks = variable.perturbShocks ? variable.perturbShocks(base, direction, shocks) : shocks;
      const result = simulate(perturbedBase, perturbedShocks, horizon);
      return {
        direction: direction > 0 ? 'increase' : 'decrease',
        deltaLabel: variable.deltaPct
          ? `${direction > 0 ? '+' : '-'}${(variable.deltaPct * 100).toFixed(0)}%`
          : `${direction > 0 ? '+' : '-'}${variable.deltaDays} days`,
        endCash: result.summary.endCash,
        minCash: result.summary.minCash,
        deltaEndCash: round2(result.summary.endCash - baselineEndCash),
        deltaMinCash: round2(result.summary.minCash - baselineMinCash),
      };
    });

    const impactMagnitude = Math.max(
      ...directions.map((d) => Math.max(Math.abs(d.deltaMinCash), Math.abs(d.deltaEndCash)))
    );
    const drivenBy = Math.max(...directions.map((d) => Math.abs(d.deltaEndCash))) >=
      Math.max(...directions.map((d) => Math.abs(d.deltaMinCash)))
      ? 'endCash' : 'minCash';

    rows.push({
      key: variable.key,
      label: variable.label,
      applicable: true,
      directions,
      impactMagnitude: round2(impactMagnitude),
      drivenBy, // which metric ('endCash' or 'minCash') the impact ranking is dominated by
    });
  }

  const ranked = rows
    .filter((r) => r.applicable)
    .sort((a, b) => b.impactMagnitude - a.impactMagnitude);

  return {
    baseline: { endCash: baselineEndCash, minCash: baselineMinCash },
    ranked,
    skipped: rows.filter((r) => !r.applicable),
  };
}

// =============================================================================
// FEATURE 2 — Break-even / safe-zone finder
// =============================================================================
// Binary search over a single numeric parameter to find the maximum (or
// minimum) value that still keeps the business "safe": cash never goes
// negative, and by the end of the horizon there's still at least
// `targetMinRunwayMonths` of runway left at the prevailing burn rate.

const DEFAULT_TARGET_MIN_RUNWAY_MONTHS = 6;

function isOutcomeSafe(result, targetMinRunwayMonths) {
  const s = result.summary;
  if (s.criticalMonthCount > 0) return false; // ever went cash-negative
  const lastMonth = result.months[result.months.length - 1];
  const remainingRunway = lastMonth.netBurn > 0 ? lastMonth.cash / lastMonth.netBurn : Infinity;
  return remainingRunway >= targetMinRunwayMonths;
}

function buildThresholdShocks(shockType, value, base) {
  if (shockType === 'hire') {
    return [{ type: 'hire', month: 1, count: Math.round(value), avgMonthlySalary: base.avgMonthlySalary || 60000 }];
  }
  if (shockType === 'revenue_shock') {
    return [{ type: 'revenue_shock', startMonth: 2, pctChange: -value }];
  }
  throw new Error(`findSafeThreshold: unsupported shockType "${shockType}"`);
}

function findSafeThreshold(base, shockType, targetMinRunwayMonths = DEFAULT_TARGET_MIN_RUNWAY_MONTHS, searchRange) {
  const isInteger = shockType === 'hire';
  const range = searchRange || (isInteger ? { min: 0, max: 200 } : { min: 0, max: 1 });

  const testValue = (value) => {
    const shocks = buildThresholdShocks(shockType, value, base);
    const result = simulate(base, shocks, HORIZON_MONTHS);
    return { safe: isOutcomeSafe(result, targetMinRunwayMonths), result };
  };

  // If even the minimum (typically 0 = no shock at all) isn't safe, the
  // business is already outside its safety threshold before any shock.
  const atMin = testValue(range.min);
  if (!atMin.safe) {
    return {
      shockType,
      targetMinRunwayMonths,
      threshold: range.min,
      unit: isInteger ? 'count' : 'pct',
      result: atMin.result,
      note: 'Even the baseline (no shock) does not meet the target runway — address underlying burn first.',
    };
  }

  // If the entire range is safe, the ceiling of the search range is the answer.
  const atMax = testValue(range.max);
  if (atMax.safe) {
    return {
      shockType,
      targetMinRunwayMonths,
      threshold: range.max,
      unit: isInteger ? 'count' : 'pct',
      result: atMax.result,
      note: 'Entire search range stays within the safety threshold — consider widening the range.',
    };
  }

  // Binary search for the boundary between safe and unsafe.
  let lo = range.min; // last known safe value
  let hi = range.max; // last known unsafe value
  const iterations = isInteger ? 20 : 30;

  for (let i = 0; i < iterations; i++) {
    if (isInteger && hi - lo <= 1) break;
    const mid = isInteger ? Math.floor((lo + hi) / 2) : (lo + hi) / 2;
    const { safe } = testValue(mid);
    if (safe) lo = mid; else hi = mid;
    if (!isInteger && Math.abs(hi - lo) < 0.001) break;
  }

  const threshold = isInteger ? lo : Math.floor(lo * 1000) / 1000; // floor, never round up past the safe boundary
  let finalCheck = testValue(threshold);

  // Defensive guard: flooring should only ever move toward "more safe", but
  // verify anyway and step down further if something unexpected happens.
  let safeThreshold = threshold;
  let guard = 0;
  while (!finalCheck.safe && guard < 50) {
    safeThreshold = isInteger ? safeThreshold - 1 : round2(safeThreshold - 0.01);
    if (safeThreshold < range.min) { safeThreshold = range.min; break; }
    finalCheck = testValue(safeThreshold);
    guard++;
  }

  return {
    shockType,
    targetMinRunwayMonths,
    threshold: safeThreshold,
    unit: isInteger ? 'count' : 'pct',
    result: finalCheck.result,
  };
}

// =============================================================================
// FEATURE 3 — Monte Carlo stress test ("how likely is this outcome, really")
// =============================================================================
// Every other feature in this file answers "what happens if X" for one fixed
// set of assumptions. But nobody actually KNOWS their exact growth rate for
// the next 12 months, or whether a customer will pay late, or whether costs
// will run a bit hot. The single line on the "Revenue vs Costs" chart is one
// plausible future, presented as if it were certain.
//
// This runs the SAME simulate() function used everywhere else in this file,
// hundreds of times, each time with slightly different — but individually
// plausible — inputs drawn from named, documented probability distributions
// (see DEFAULT_MC_CONFIG below). It then reports what fraction of those
// plausible futures stay solvent, and the spread (percentile band) of cash
// outcomes month by month. Still zero LLM involvement: this is randomness
// from a seeded, reproducible pseudo-random generator, not a model guessing.

const DEFAULT_MC_TRIALS = 400;

// Every number here is a named, adjustable assumption — not a hidden magic
// constant. They're returned to the caller as part of the result (see
// `assumptions` below) so the UI can show exactly what was varied and by
// how much, instead of presenting a probability with no explanation of
// where it came from.
const DEFAULT_MC_CONFIG = {
  trials: DEFAULT_MC_TRIALS,
  // Fixed by default so the same inputs always reproduce the exact same
  // result — "run it again" should be auditable, not a different answer
  // every time. Callers that want fresh randomness can pass their own seed
  // (e.g. Date.now()).
  seed: 42,
  // Trial-to-trial uncertainty in the GROWTH TREND itself: nobody knows if
  // next year's growth rate will really be exactly today's number. Modeled
  // as ±50% of the growth rate's own magnitude, one draw per trial (the
  // trend is uncertain, not re-rolled every month).
  growthRateStdDevPct: 0.5,
  // Month-to-month demand volatility AROUND whatever the trend says:
  // real revenue wobbles month to month even when the underlying trend is
  // stable. ±7%, one independent draw PER MONTH per trial.
  monthlyRevenueNoisePct: 0.07,
  // Whole-year fixed-cost overrun/underrun risk: costs tend to run
  // consistently a bit high or low all year (a lease renegotiation, a tool
  // price hike), not wobble randomly month to month. ±8%, one draw per
  // trial, applied to every month of that trial.
  fixedCostOverrunPct: 0.08,
  // Chance, per trial, that ONE significant customer payment slips late
  // sometime in the year — the single most common real-world cash surprise
  // for the SMB/D2C/SaaS profiles this app targets.
  latePaymentProbability: 0.25,
};

// Deterministic seeded PRNG (mulberry32) — same seed always produces the
// same sequence, so a Monte Carlo run is exactly reproducible, not "trust
// me, I rolled some dice."
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller transform: turns two uniform (0,1) samples from the PRNG above
// into one normally-distributed sample with the given mean/stdDev. Used for
// every "realistic swing" in this feature — real-world financial variables
// cluster around an expected value and get rarer the further they stray,
// which a uniform random range does not capture.
function sampleNormal(rand, mean, stdDev) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdDev;
}

// Linear-interpolated percentile of an already-sorted array.
function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round2(sortedValues[lo]);
  const frac = idx - lo;
  return round2(sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * frac);
}

/**
 * Run `config.trials` independent plausible futures for `base`+`shocks` and
 * summarize the spread of outcomes. Every trial calls the exact same
 * simulate() used by every other feature — Monte Carlo doesn't reinvent the
 * financial math, it just feeds it many plausible inputs instead of one.
 *
 * @param {Object} base - same shape as simulate()'s base
 * @param {Array} shocks - same shocks[] any other scenario would use (e.g.
 *   the recommended what-if scenario's shocks, or [] for the plain baseline)
 * @param {Object} [userConfig] - overrides for any DEFAULT_MC_CONFIG key
 * @returns {Object} percentile bands per month, survival probability, and
 *   the full set of assumptions used (for UI transparency)
 */
function monteCarloSimulate(base, shocks = [], userConfig = {}) {
  const config = { ...DEFAULT_MC_CONFIG, ...userConfig };
  const rand = mulberry32(config.seed);
  const horizon = HORIZON_MONTHS;

  const trials = [];

  for (let t = 0; t < config.trials; t++) {
    // One draw per trial: this trial's actual growth rate and fixed-cost
    // level, held constant across all 12 months of THIS trial.
    const growthRate = sampleNormal(
      rand,
      base.growthRate || 0,
      Math.abs(base.growthRate || 0.02) * config.growthRateStdDevPct
    );
    const fixedCostMultiplier = Math.max(0, 1 + sampleNormal(rand, 0, config.fixedCostOverrunPct));

    // One draw per month: independent demand noise around the trend.
    const monthlyRevenueMultipliers = [];
    for (let m = 0; m < horizon; m++) {
      monthlyRevenueMultipliers.push(Math.max(0, 1 + sampleNormal(rand, 0, config.monthlyRevenueNoisePct)));
    }

    // Coin-flip per trial: does a customer payment slip late this year, and
    // if so, when/how much/how late — all randomized, not fixed.
    let trialShocks = shocks;
    if (rand() < config.latePaymentProbability) {
      const fromMonth = 1 + Math.floor(rand() * horizon);
      const delayMonths = 1 + Math.floor(rand() * 2); // 1-2 months late
      const amount = base.monthlyRevenue * (0.1 + rand() * 0.3); // 10-40% of a month's revenue
      trialShocks = [...shocks, { type: 'delay_payment', fromMonth, amount, delayMonths }];
    }

    const trialBase = {
      ...base,
      growthRate,
      monthlyFixedCosts: base.monthlyFixedCosts * fixedCostMultiplier,
    };

    const result = simulate(trialBase, trialShocks, horizon, { monthlyRevenueMultipliers });

    trials.push({
      cashByMonth: result.months.map((mo) => mo.cash),
      endCash: result.summary.endCash,
      goesNegative: result.summary.goesNegative,
      monthOfInsolvency: result.summary.monthOfInsolvency,
    });
  }

  // Per-month percentile bands (the "fan chart" data): for each month,
  // sort every trial's cash value and read off the percentiles. p10/p90
  // is the "80% of plausible outcomes fall in this range" band; p25/p75
  // is the tighter 50% band; p50 is the median (typical) path.
  const months = [];
  for (let m = 0; m < horizon; m++) {
    const values = trials.map((tr) => tr.cashByMonth[m]).sort((a, b) => a - b);
    months.push({
      month: m + 1,
      p10: percentile(values, 10),
      p25: percentile(values, 25),
      p50: percentile(values, 50),
      p75: percentile(values, 75),
      p90: percentile(values, 90),
    });
  }

  const negativeCount = trials.filter((tr) => tr.goesNegative).length;
  const survivalProbability = round2(100 * (1 - negativeCount / config.trials));

  const endCashSorted = trials.map((tr) => tr.endCash).sort((a, b) => a - b);
  const insolvencyMonths = trials.filter((tr) => tr.goesNegative).map((tr) => tr.monthOfInsolvency);

  return {
    trials: config.trials,
    seed: config.seed,
    // % of the trials that NEVER went cash-negative at any point in the
    // 12-month horizon — the single clearest "is this actually safe" number.
    survivalProbability,
    // Fan-chart data: percentile cash band for every month.
    months,
    endCash: {
      p10: percentile(endCashSorted, 10),
      p50: percentile(endCashSorted, 50),
      p90: percentile(endCashSorted, 90),
    },
    worstCase: {
      minEndCash: round2(endCashSorted[0]),
      earliestInsolvencyMonth: insolvencyMonths.length ? Math.min(...insolvencyMonths) : null,
      insolventTrialPct: round2(100 * insolvencyMonths.length / config.trials),
    },
    // Full transparency on what was actually varied, for the UI to explain
    // itself rather than presenting a bare percentage.
    assumptions: config,
  };
}

// =============================================================================
// FEATURE 4 — Financial Risk Radar (proactive, deterministic risk detection)
// =============================================================================
// Everything below reuses simulate()/baselineRunway() — it never re-derives
// cash math independently. It only reads the profile's own numbers (plus,
// for growth risk, a binary search that repeatedly calls simulate() the same
// way findSafeThreshold() already does above) and classifies the result
// against fixed, documented thresholds. Zero LLM involvement; the agent
// layer (agent.js) may only phrase the `title`/`whyItMatters` text found
// here in a different voice — it can never change the severity or value.

const RISK_SEVERITY_ORDER = { high: 3, medium: 2, watch: 1, healthy: 0 };

// Point deductions from the 100-point Financial Health Score, per category
// per severity. Different categories carry different max weight because a
// cash-buffer or growth problem is more existential than a single watch-list
// item — this table is the ENTIRE scoring model, nothing is hidden.
const HEALTH_SCORE_WEIGHTS = {
  customerConcentration: { healthy: 0, watch: 3, medium: 6, high: 10 },
  paymentCycle: { healthy: 0, watch: 3, medium: 6, high: 10 },
  cashBuffer: { healthy: 0, watch: 4, medium: 8, high: 15 },
  revenueGrowth: { healthy: 0, watch: 3, medium: 6, high: 12 },
  burnCost: { healthy: 0, watch: 2, medium: 5, high: 9 },
};

function round1(n) {
  return Math.round(n * 10) / 10;
}

// --- A. Customer concentration ---------------------------------------------
// Uses per-customer breakdown (`profile.customers`) if present; otherwise
// falls back to the profile's aggregate `customerConcentration` figure.
// Both are plain profile data — this function only classifies them.
function detectCustomerConcentrationRisk(profile) {
  let largestShare = null;
  let isDemoData = false;
  if (Array.isArray(profile.customers) && profile.customers.length) {
    largestShare = Math.max(...profile.customers.map((c) => c.revenueShare));
    isDemoData = !!profile.customersAreDemoData;
  } else if (typeof profile.customerConcentration === 'number') {
    largestShare = profile.customerConcentration;
  }

  if (largestShare == null) {
    return {
      key: 'customerConcentration',
      title: 'CUSTOMER CONCENTRATION',
      severity: 'watch',
      available: false,
      value: 'No data',
      summary: 'Connect transaction/customer data to calculate this risk.',
      whyItMatters: 'A major customer delay or loss can materially affect cash flow, but this needs customer-level revenue data to quantify.',
      calculation: 'largest customer revenue ÷ total revenue × 100',
      threshold: 'n/a — missing data',
    };
  }

  const pct = round1(largestShare * 100);
  let severity;
  if (pct < 20) severity = 'healthy';
  else if (pct < 30) severity = 'watch';
  else if (pct < 40) severity = 'medium';
  else severity = 'high';

  return {
    key: 'customerConcentration',
    title: 'CUSTOMER CONCENTRATION',
    severity,
    available: true,
    isDemoData,
    value: `${pct}%`,
    summary: `${pct}% of revenue comes from your largest customer.`,
    whyItMatters: 'A major customer delay or loss could significantly affect cash flow.',
    calculation: 'largest customer revenue ÷ total revenue × 100',
    threshold: '< 20% healthy · 20–30% watch · 30–40% medium · > 40% high',
    simulateQuestion: 'What if my biggest customer is delayed by 15 days?',
  };
}

// --- B. Payment-cycle / receivables risk ------------------------------------
// Working-capital exposure = monthly revenue × payment terms (days) / 30 —
// i.e. how much revenue is, on average, sitting uncollected at any time.
function detectPaymentCycleRisk(profile) {
  const days = profile.paymentTermsDays || 0;
  const exposure = round2((profile.monthlyRevenue || 0) * (days / 30));

  let severity;
  if (days < 15) severity = 'healthy';
  else if (days < 30) severity = 'watch';
  else if (days < 45) severity = 'medium';
  else severity = 'high';

  return {
    key: 'paymentCycle',
    title: 'PAYMENT-CYCLE EXPOSURE',
    severity,
    available: true,
    value: fmtMoneyShort(exposure, profile.currency),
    days,
    exposure,
    summary: `${fmtMoneyShort(exposure, profile.currency)} of working capital is exposed to delayed collections (${days}-day terms).`,
    whyItMatters: 'The longer customers take to pay, the more cash is tied up in receivables instead of your bank account — a real shock (one big client paying even later) hits cash immediately.',
    calculation: 'monthly revenue × payment terms (days) ÷ 30',
    threshold: '< 15 days healthy · 15–30 watch · 30–45 medium · > 45 high',
    simulateQuestion: 'What if my biggest customer pays 15 days late?',
  };
}

// --- C. Revenue growth risk --------------------------------------------------
// Finds the MINIMUM monthly growth rate that still keeps the business "safe"
// (never cash-negative, ≥ targetMinRunwayMonths of runway left at month 12),
// via the same binary-search pattern as findSafeThreshold() above, then
// compares the profile's actual growth rate against that computed floor.
function findSafeGrowthRate(base, targetMinRunwayMonths = DEFAULT_TARGET_MIN_RUNWAY_MONTHS) {
  const testValue = (growthRate) => {
    const result = simulate({ ...base, growthRate }, [], HORIZON_MONTHS);
    return { safe: isOutcomeSafe(result, targetMinRunwayMonths), result };
  };

  let lo = -0.3; // last known UNSAFE lower bound (very negative growth)
  let hi = 0.3;  // last known SAFE upper bound (strong growth)

  const atHi = testValue(hi);
  if (!atHi.safe) {
    // Even strong growth doesn't save it — burn/cost structure is the real
    // problem, not growth. Report the ceiling as the (unreachable) floor.
    return { requiredGrowthRate: hi, reachable: false };
  }
  const atLo = testValue(lo);
  if (atLo.safe) {
    // Safe even with steep decline — growth is a non-issue for this profile.
    return { requiredGrowthRate: lo, reachable: true, alwaysSafe: true };
  }

  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const { safe } = testValue(mid);
    if (safe) hi = mid; else lo = mid;
    if (Math.abs(hi - lo) < 0.0005) break;
  }

  return { requiredGrowthRate: Math.round(hi * 10000) / 10000, reachable: true };
}

function detectRevenueGrowthRisk(profile) {
  const current = profile.growthRate || 0;
  const { requiredGrowthRate, reachable, alwaysSafe } = findSafeGrowthRate(profile);
  const gapPts = round1((current - requiredGrowthRate) * 100 * 10) / 10; // percentage points, 1 decimal

  let severity;
  const baselineResult = simulate(profile, [], HORIZON_MONTHS);
  if (!reachable || baselineResult.summary.goesNegative) {
    severity = 'high';
  } else if (current < requiredGrowthRate) {
    severity = 'medium';
  } else if (current < requiredGrowthRate + 0.01) {
    severity = 'watch'; // within 1 point of the floor — thin margin of safety
  } else {
    severity = 'healthy';
  }

  const requiredPctLabel = `${round1(requiredGrowthRate * 100)}%/mo`;
  const currentPctLabel = `${round1(current * 100)}%/mo`;

  return {
    key: 'revenueGrowth',
    title: 'REVENUE GROWTH RISK',
    severity,
    available: true,
    value: currentPctLabel,
    requiredGrowthRate,
    gapPts,
    summary: alwaysSafe
      ? `Growing at ${currentPctLabel}; comfortably above the floor needed to stay safe.`
      : `Growing at ${currentPctLabel}, vs. ${requiredPctLabel} needed to keep a ${DEFAULT_TARGET_MIN_RUNWAY_MONTHS}-month runway buffer.`,
    whyItMatters: 'If growth falls below the level needed to sustain current costs, cash reserves erode and the runway shortens.',
    calculation: `binary search for the minimum monthly growth rate that keeps cash positive and runway ≥ ${DEFAULT_TARGET_MIN_RUNWAY_MONTHS} months over ${HORIZON_MONTHS} months (same method as the Safe Limits panel)`,
    threshold: `current growth vs. required growth of ${requiredPctLabel}`,
    simulateQuestion: 'What if revenue drops 20%?',
  };
}

// --- D. Cash buffer risk ------------------------------------------------------
// Minimum safe cash floor reuses the EXACT same "2× current monthly burn"
// definition already used by riskLevel() above and shown in the Safe Limits
// panel (safeMinCashValue) — so this card and that panel are always
// consistent with each other, not a second, slightly-different rule.
function detectCashBufferRisk(profile) {
  const netBurn = (profile.monthlyFixedCosts || 0) + (profile.monthlyPayroll || 0) - (profile.monthlyRevenue || 0);
  const currency = profile.currency || '₹';

  if (netBurn <= 0) {
    return {
      key: 'cashBuffer',
      title: 'CASH BUFFER',
      severity: 'healthy',
      available: true,
      value: 'Profitable',
      minSafeCash: 0,
      buffer: profile.startingCash,
      summary: `Business is cash-flow positive — no burn-based safety floor applies.`,
      whyItMatters: 'A profitable month-on-month position means cash reserves are not being depleted by operations.',
      calculation: 'minimum safe cash = 2 × current monthly net burn (0 when burn ≤ 0, i.e. profitable)',
      threshold: 'n/a — profitable',
    };
  }

  const minSafeCash = round2(netBurn * 2);
  const buffer = round2(profile.startingCash - minSafeCash);
  const bufferRatio = buffer / minSafeCash; // how many "floors" above zero

  let severity;
  if (buffer < 0) severity = 'high';
  else if (bufferRatio < 0.25) severity = 'medium';
  else if (bufferRatio < 1) severity = 'watch';
  else severity = 'healthy';

  return {
    key: 'cashBuffer',
    title: 'CASH BUFFER',
    severity,
    available: true,
    value: `${fmtMoneyShort(Math.abs(buffer), currency)} ${buffer >= 0 ? 'above' : 'below'} floor`,
    minSafeCash,
    buffer,
    summary: buffer >= 0
      ? `${fmtMoneyShort(buffer, currency)} above your calculated safety floor.`
      : `${fmtMoneyShort(Math.abs(buffer), currency)} BELOW your calculated safety floor.`,
    whyItMatters: buffer >= 0
      ? 'Current liquidity provides a buffer against moderate shocks.'
      : 'Cash is already under the level considered safe at the current burn rate — a shock could push the business to insolvency quickly.',
    calculation: 'minimum safe cash = 2 × current monthly net burn; buffer = starting cash − minimum safe cash',
    threshold: '≥100% of floor above it: healthy · 25–100%: watch · 0–25%: medium · below floor: high',
    simulateQuestion: 'What if fixed costs increase 10%?',
  };
}

// --- E. Burn / cost risk -----------------------------------------------------
// Compares revenue growth against `profile.costGrowthRate` — a modeling
// assumption for the expected monthly drift in fixed costs + payroll
// (inflation, planned raises, tooling/lease escalators), stored on the
// profile exactly the way `growthRate` already is. Both are declared model
// inputs, not numbers invented at request time.
function detectBurnCostRisk(profile) {
  const revenueGrowth = profile.growthRate || 0;
  const costGrowth = typeof profile.costGrowthRate === 'number' ? profile.costGrowthRate : null;

  if (costGrowth == null) {
    return {
      key: 'burnCost',
      title: 'BURN / COST RISK',
      severity: 'watch',
      available: false,
      value: 'No data',
      summary: 'Connect a cost-growth assumption to calculate this risk.',
      whyItMatters: 'Costs growing faster than revenue erode margins and shorten runway over time.',
      calculation: 'cost growth rate − revenue growth rate',
      threshold: 'n/a — missing data',
    };
  }

  const gapPts = round1((costGrowth - revenueGrowth) * 100 * 10) / 10;

  let severity;
  if (costGrowth <= revenueGrowth) severity = 'healthy';
  else if (gapPts < 2) severity = 'watch';
  else if (gapPts < 4) severity = 'medium';
  else severity = 'high';

  return {
    key: 'burnCost',
    title: 'BURN / COST RISK',
    severity,
    available: true,
    value: `${round1(costGrowth * 100)}%/mo costs vs ${round1(revenueGrowth * 100)}%/mo revenue`,
    revenueGrowth,
    costGrowth,
    gapPts,
    summary: costGrowth <= revenueGrowth
      ? `Costs (${round1(costGrowth * 100)}%/mo) are growing no faster than revenue (${round1(revenueGrowth * 100)}%/mo).`
      : `Costs are growing ${round1(costGrowth * 100)}%/mo vs. revenue at ${round1(revenueGrowth * 100)}%/mo — a ${gapPts}-point gap.`,
    whyItMatters: 'If costs consistently outpace revenue growth, margins compress every month even while the top line looks fine.',
    calculation: 'gap = cost growth rate assumption − revenue growth rate (both are monthly modeling assumptions on the business profile)',
    threshold: 'costs ≤ revenue growth: healthy · 0–2pt gap: watch · 2–4pt: medium · > 4pt: high',
    simulateQuestion: 'What if fixed costs increase 10%?',
  };
}

function fmtMoneyShort(n, currency = '₹') {
  return `${currency}${Math.round(n).toLocaleString('en-IN')}`;
}

// --- Orchestrator: run every detector, score, and prioritize ----------------
function analyzeRisks(profile) {
  const detectors = [
    detectCustomerConcentrationRisk,
    detectPaymentCycleRisk,
    detectRevenueGrowthRisk,
    detectCashBufferRisk,
    detectBurnCostRisk,
  ];

  const risks = detectors.map((fn) => fn(profile));

  const deductions = risks.map((r) => {
    const weights = HEALTH_SCORE_WEIGHTS[r.key];
    const points = r.available === false ? 0 : (weights ? weights[r.severity] || 0 : 0);
    return { key: r.key, label: r.title, severity: r.severity, points };
  });

  const totalDeduction = deductions.reduce((sum, d) => sum + d.points, 0);
  const score = Math.max(0, Math.min(100, 100 - totalDeduction));

  risks.forEach((r) => {
    const d = deductions.find((x) => x.key === r.key);
    r.deductionPoints = d ? d.points : 0;
  });

  // Sort by severity first (high -> healthy), then by point impact within
  // the same severity tier, so the single most important risk is always #1.
  const sorted = [...risks].sort((a, b) => {
    const sevDiff = RISK_SEVERITY_ORDER[b.severity] - RISK_SEVERITY_ORDER[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return (b.deductionPoints || 0) - (a.deductionPoints || 0);
  });

  return {
    financialHealth: {
      score: round1(score),
      base: 100,
      deductions: deductions.filter((d) => d.points > 0),
    },
    risks: sorted,
  };
}

module.exports = {
  simulate,
  baselineRunway,
  sensitivityAnalysis,
  findSafeThreshold,
  monteCarloSimulate,
  analyzeRisks,
  findSafeGrowthRate,
  HORIZON_MONTHS,
};
