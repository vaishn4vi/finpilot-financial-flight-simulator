/**
 * engine.test.js — Tests for the DETERMINISTIC financial engine (engine.js).
 * Uses Node's built-in test runner (`node --test`), zero extra deps.
 *
 * These tests check actual financial arithmetic, not just "does it return
 * 200" — per the project's own auditability principle, engine.js is where
 * bugs must be caught, since agent.js/LLM never touch the numbers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine');

const BASE = {
  startingCash: 1000000,
  monthlyRevenue: 200000,
  monthlyFixedCosts: 80000,
  monthlyPayroll: 100000,
  growthRate: 0.02,
  paymentTermsDays: 15,
  avgMonthlySalary: 60000,
};

test('baseline: profitable business has null runway', () => {
  const b = engine.baselineRunway({ ...BASE, monthlyRevenue: 300000 });
  assert.equal(b.isProfitable, true);
  assert.equal(b.runwayMonths, null);
});

test('baseline: burning business has a finite runway = cash / netBurn', () => {
  const base = { ...BASE, monthlyRevenue: 50000 }; // burns 130,000/mo
  const b = engine.baselineRunway(base);
  assert.equal(b.isProfitable, false);
  assert.ok(Math.abs(b.runwayMonths - base.startingCash / 130000) < 1e-9);
});

test('simulate: month 1 cash reflects fixed costs + payroll - revenue exactly', () => {
  const result = engine.simulate(BASE, [], 3);
  const expectedNetBurn = BASE.monthlyFixedCosts + BASE.monthlyPayroll - BASE.monthlyRevenue;
  assert.equal(result.months[0].netBurn, expectedNetBurn);
  assert.equal(result.months[0].cash, BASE.startingCash - expectedNetBurn);
});

test('simulate: revenue grows compounding by growthRate month over month', () => {
  const result = engine.simulate(BASE, [], 3);
  const m1 = result.months[0].revenue;
  const m2 = result.months[1].revenue;
  const expectedRatio = 1 + BASE.growthRate;
  assert.ok(Math.abs(m2 / m1 - expectedRatio) < 1e-6);
});

test('simulate: hire shock increases payroll from the hire month onward, not before', () => {
  const shocks = [{ type: 'hire', month: 3, count: 2, avgMonthlySalary: 50000 }];
  const result = engine.simulate(BASE, shocks, 5);
  assert.equal(result.months[0].costs, BASE.monthlyFixedCosts + BASE.monthlyPayroll); // month 1: no hire yet
  assert.equal(result.months[1].costs, BASE.monthlyFixedCosts + BASE.monthlyPayroll); // month 2: no hire yet
  assert.equal(result.months[2].costs, BASE.monthlyFixedCosts + BASE.monthlyPayroll + 100000); // month 3: +2*50000
  assert.equal(result.months[3].costs, BASE.monthlyFixedCosts + BASE.monthlyPayroll + 100000); // month 4: cumulative
});

test('simulate: revenue_shock with negative pctChange reduces revenue by that fraction', () => {
  const shocks = [{ type: 'revenue_shock', startMonth: 1, pctChange: -0.2 }];
  const noShock = engine.simulate(BASE, [], 1);
  const withShock = engine.simulate(BASE, shocks, 1);
  assert.ok(Math.abs(withShock.months[0].revenue - noShock.months[0].revenue * 0.8) < 1e-6);
});

test('simulate: delay_payment removes revenue in fromMonth and re-adds it delayMonths later', () => {
  const shocks = [{ type: 'delay_payment', fromMonth: 2, amount: 50000, delayMonths: 1 }];
  const result = engine.simulate(BASE, shocks, 4);
  const baseline = engine.simulate(BASE, [], 4);
  // Month 2 revenue is reduced by exactly 50000 vs no-shock baseline
  assert.ok(Math.abs((baseline.months[1].revenue - result.months[1].revenue) - 50000) < 1e-6);
  // Month 3 gets the deferred inflow, so realized revenue (revenue+deferred)
  // recovers the 50000 back
  assert.equal(result.months[2].deferredInflow, 50000);
});

test('simulate: negative cash is flagged critical risk', () => {
  const brokeBase = { ...BASE, startingCash: 10000, monthlyRevenue: 0 };
  const result = engine.simulate(brokeBase, [], 2);
  assert.ok(result.months[0].cash < 0);
  assert.equal(result.months[0].risk, 'critical');
  assert.equal(result.summary.goesNegative, true);
  assert.equal(result.summary.monthOfInsolvency, 1);
});

test('simulate: compound shocks (hire + revenue drop) both apply in the same run', () => {
  const shocks = [
    { type: 'hire', month: 1, count: 3, avgMonthlySalary: 50000 },
    { type: 'revenue_shock', startMonth: 1, pctChange: -0.3 },
  ];
  const result = engine.simulate(BASE, shocks, 1);
  const expectedRevenue = BASE.monthlyRevenue * 0.7;
  const expectedCosts = BASE.monthlyFixedCosts + BASE.monthlyPayroll + 3 * 50000;
  assert.ok(Math.abs(result.months[0].revenue - expectedRevenue) < 1e-6);
  assert.equal(result.months[0].costs, expectedCosts);
});

test('sensitivityAnalysis: returns a ranked list sorted by descending impact magnitude', () => {
  const sa = engine.sensitivityAnalysis(BASE, []);
  assert.ok(sa.ranked.length > 0);
  for (let i = 1; i < sa.ranked.length; i++) {
    assert.ok(sa.ranked[i - 1].impactMagnitude >= sa.ranked[i].impactMagnitude);
  }
});

test('sensitivityAnalysis: cost-per-hire variable is skipped when no hire shock present', () => {
  const sa = engine.sensitivityAnalysis(BASE, []);
  const skippedKeys = sa.skipped.map((s) => s.key);
  assert.ok(skippedKeys.includes('hireCost'));
});

test('findSafeThreshold: hiring threshold is safe (no negative cash within horizon)', () => {
  const richBase = { ...BASE, startingCash: 20000000, monthlyRevenue: 2000000 };
  const t = engine.findSafeThreshold(richBase, 'hire', 6);
  const shocks = [{ type: 'hire', month: 1, count: t.threshold, avgMonthlySalary: richBase.avgMonthlySalary }];
  const check = engine.simulate(richBase, shocks, engine.HORIZON_MONTHS);
  assert.equal(check.summary.goesNegative, false);
});

test('findSafeThreshold: one hire more than the threshold should NOT be safe (boundary is tight)', () => {
  const richBase = { ...BASE, startingCash: 900000, monthlyRevenue: 300000, avgMonthlySalary: 100000 };
  const t = engine.findSafeThreshold(richBase, 'hire', 6, { min: 0, max: 20 });
  if (t.threshold < 20) {
    const overShocks = [{ type: 'hire', month: 1, count: t.threshold + 1, avgMonthlySalary: richBase.avgMonthlySalary }];
    const overResult = engine.simulate(richBase, overShocks, engine.HORIZON_MONTHS);
    const lastMonth = overResult.months[overResult.months.length - 1];
    const remainingRunway = lastMonth.netBurn > 0 ? lastMonth.cash / lastMonth.netBurn : Infinity;
    const isSafe = overResult.summary.criticalMonthCount === 0 && remainingRunway >= 6;
    assert.equal(isSafe, false);
  }
});

test('findSafeThreshold: revenue-drop threshold is a fraction between 0 and 1', () => {
  const t = engine.findSafeThreshold(BASE, 'revenue_shock', 6);
  assert.ok(t.threshold >= 0 && t.threshold <= 1);
});

test('edge case: zero horizon-relevant shocks still produces a full 12-month series', () => {
  const result = engine.simulate(BASE, []);
  assert.equal(result.months.length, engine.HORIZON_MONTHS);
});

test('edge case: floating point rounding never leaves more than 2 decimal places', () => {
  const result = engine.simulate(BASE, [{ type: 'revenue_shock', startMonth: 1, pctChange: 0.0333 }]);
  for (const m of result.months) {
    const decimals = (m.cash.toString().split('.')[1] || '').length;
    assert.ok(decimals <= 2, `cash ${m.cash} has more than 2 decimal places`);
  }
});

// =============================================================================
// FEATURE 3 — Monte Carlo stress test
// =============================================================================

test('monteCarloSimulate: simulate() with monthlyRevenueMultipliers scales revenue exactly, per month', () => {
  const multipliers = [0.5, 1, 2];
  const result = engine.simulate(BASE, [], 3, { monthlyRevenueMultipliers: multipliers });
  const expectedM1Revenue = BASE.monthlyRevenue * multipliers[0];
  const expectedM3Revenue = BASE.monthlyRevenue * Math.pow(1 + BASE.growthRate, 2) * multipliers[2];
  assert.ok(Math.abs(result.months[0].revenue - expectedM1Revenue) < 1e-6);
  assert.ok(Math.abs(result.months[2].revenue - expectedM3Revenue) < 1e-6);
});

test('monteCarloSimulate: omitting monthlyRevenueMultipliers leaves simulate() unchanged (backward compatible)', () => {
  const withOptions = engine.simulate(BASE, [], 6, {});
  const withoutOptions = engine.simulate(BASE, [], 6);
  assert.deepEqual(withOptions, withoutOptions);
});

test('monteCarloSimulate: same seed always reproduces the exact same result (auditable, not "trust me")', () => {
  const a = engine.monteCarloSimulate(BASE, [], { trials: 50, seed: 7 });
  const b = engine.monteCarloSimulate(BASE, [], { trials: 50, seed: 7 });
  assert.deepEqual(a, b);
});

test('monteCarloSimulate: different seeds produce different (but each internally valid) results', () => {
  const a = engine.monteCarloSimulate(BASE, [], { trials: 50, seed: 1 });
  const b = engine.monteCarloSimulate(BASE, [], { trials: 50, seed: 2 });
  assert.notDeepEqual(a.months, b.months);
});

test('monteCarloSimulate: returns one percentile row per horizon month', () => {
  const mc = engine.monteCarloSimulate(BASE, [], { trials: 50 });
  assert.equal(mc.months.length, engine.HORIZON_MONTHS);
  assert.equal(mc.months[0].month, 1);
  assert.equal(mc.months[mc.months.length - 1].month, engine.HORIZON_MONTHS);
});

test('monteCarloSimulate: percentiles are monotonic (p10 <= p25 <= p50 <= p75 <= p90) every month', () => {
  const mc = engine.monteCarloSimulate(BASE, [], { trials: 200 });
  for (const m of mc.months) {
    assert.ok(m.p10 <= m.p25, `month ${m.month}: p10 > p25`);
    assert.ok(m.p25 <= m.p50, `month ${m.month}: p25 > p50`);
    assert.ok(m.p50 <= m.p75, `month ${m.month}: p50 > p75`);
    assert.ok(m.p75 <= m.p90, `month ${m.month}: p75 > p90`);
  }
});

test('monteCarloSimulate: survivalProbability is between 0 and 100', () => {
  const mc = engine.monteCarloSimulate(BASE, [], { trials: 200 });
  assert.ok(mc.survivalProbability >= 0 && mc.survivalProbability <= 100);
});

test('monteCarloSimulate: a comfortably profitable business has a near-100% survival probability', () => {
  const healthy = { ...BASE, startingCash: 50000000, monthlyRevenue: 1000000, monthlyFixedCosts: 50000, monthlyPayroll: 50000 };
  const mc = engine.monteCarloSimulate(healthy, [], { trials: 300 });
  assert.ok(mc.survivalProbability > 95, `expected near-100%, got ${mc.survivalProbability}`);
});

test('monteCarloSimulate: an already-insolvent-trajectory business has a near-0% survival probability', () => {
  const dying = { ...BASE, startingCash: 10000, monthlyRevenue: 10000, monthlyFixedCosts: 200000, monthlyPayroll: 200000 };
  const mc = engine.monteCarloSimulate(dying, [], { trials: 300 });
  assert.ok(mc.survivalProbability < 5, `expected near-0%, got ${mc.survivalProbability}`);
});

test('monteCarloSimulate: assumptions object echoes back the actual config used (transparency)', () => {
  const mc = engine.monteCarloSimulate(BASE, [], { trials: 123, seed: 9, latePaymentProbability: 0.5 });
  assert.equal(mc.assumptions.trials, 123);
  assert.equal(mc.assumptions.seed, 9);
  assert.equal(mc.assumptions.latePaymentProbability, 0.5);
});

test('monteCarloSimulate: shocks passed in (e.g. a hiring plan) are applied on top of every trial', () => {
  const hireShocks = [{ type: 'hire', month: 1, count: 50, avgMonthlySalary: 100000 }];
  const withHires = engine.monteCarloSimulate(BASE, hireShocks, { trials: 150 });
  const withoutHires = engine.monteCarloSimulate(BASE, [], { trials: 150 });
  assert.ok(withHires.survivalProbability <= withoutHires.survivalProbability);
});
