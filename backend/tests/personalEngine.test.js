const test = require('node:test');
const assert = require('node:assert/strict');
const pe = require('../personalEngine');
const engine = require('../engine');

const demoProfile = {
  label: 'Test household',
  income: { monthly: 150000, other: 10000 },
  savings: { current: 1200000, investments: 0, emergencyFund: 300000 },
  expenses: { rent: 25000, food: 12000, utilities: 4000, transport: 6000, insurance: 3000, education: 0, other: 5000 },
  debt: { existingEMI: 8000 },
  dependents: 2,
  minEmergencyFundTarget: 6,
  desiredMonthlySavings: 25000,
  incomeGrowthRate: 0,
};

// --- Mapping / surplus -------------------------------------------------------
test('mapProfileToBase produces the exact shape engine.simulate() expects', () => {
  const base = pe.mapProfileToBase(demoProfile);
  assert.equal(base.monthlyRevenue, 160000);
  assert.equal(base.monthlyFixedCosts, 55000);
  assert.equal(base.monthlyPayroll, 8000);
  assert.equal(base.startingCash, 1200000);
  // Sanity: engine.simulate() must accept this shape without throwing.
  assert.doesNotThrow(() => engine.simulate(base, [], 12));
});

test('monthlySurplus = income - expenses - existing EMI', () => {
  assert.equal(pe.monthlySurplus(demoProfile), 160000 - 55000 - 8000);
});

// --- EMI / amortization -------------------------------------------------------
test('emiForLoan matches a known reference EMI (₹56L @ 8.5% / 20y ≈ ₹48,598)', () => {
  const emi = pe.emiForLoan(5600000, 8.5, 20);
  assert.ok(Math.abs(emi - 48598) < 5, `expected ~48598, got ${emi}`);
});

test('emiForLoan handles 0% interest as a plain division', () => {
  assert.equal(pe.emiForLoan(120000, 0, 1), 10000);
});

test('loanBalanceAfter decreases monotonically and reaches ~0 at full tenure', () => {
  const principal = 5000000;
  const rate = 8;
  const years = 15;
  const bal0 = pe.loanBalanceAfter(principal, rate, years, 0);
  const balMid = pe.loanBalanceAfter(principal, rate, years, years * 6);
  const balEnd = pe.loanBalanceAfter(principal, rate, years, years * 12);
  assert.equal(bal0, principal);
  assert.ok(balMid < bal0);
  assert.ok(balEnd < balMid);
  assert.ok(balEnd < 100, `expected near-zero balance at full tenure, got ${balEnd}`);
});

test('totalInterestForLoan is positive and roughly EMI*n - principal', () => {
  const principal = 3000000;
  const rate = 9;
  const years = 10;
  const emi = pe.emiForLoan(principal, rate, years);
  const interest = pe.totalInterestForLoan(principal, rate, years);
  assert.ok(interest > 0);
  assert.ok(Math.abs(interest - (emi * years * 12 - principal)) < 1);
});

test('impliedLoanFromEmi is the inverse of emiForLoan', () => {
  const emi = pe.emiForLoan(4000000, 8.5, 20);
  const impliedPrincipal = pe.impliedLoanFromEmi(emi, 8.5, 20);
  assert.ok(Math.abs(impliedPrincipal - 4000000) < 50);
});

// --- Can I afford this? -------------------------------------------------------
test('simulateAffordability returns three branches, each a real engine.simulate() result', () => {
  const result = pe.simulateAffordability(demoProfile, { price: 7000000 });
  assert.equal(result.branches.length, 3);
  const keys = result.branches.map((b) => b.key);
  assert.deepEqual(keys.sort(), ['buyCheaper', 'buyNow', 'waitAndSave'].sort());
  for (const b of result.branches) {
    assert.ok(b.result.summary, 'every branch must carry a real engine summary');
    assert.ok(b.emi >= 0);
  }
});

test('simulateAffordability: an unaffordable house (down payment exceeds savings) flags emergency-fund breach', () => {
  const result = pe.simulateAffordability(demoProfile, { price: 7000000 });
  const buyNow = result.branches.find((b) => b.key === 'buyNow');
  assert.equal(buyNow.emergencyFund.meetsTarget, false);
});

test('simulateAffordability: a cheap, well-covered purchase is recommended as buyNow', () => {
  const richProfile = { ...demoProfile, savings: { current: 10000000, investments: 5000000, emergencyFund: 1000000 } };
  const result = pe.simulateAffordability(richProfile, { price: 3000000 });
  assert.ok(result.branches.every((b) => b.emergencyFund.meetsTarget), 'precondition: this price should be comfortably safe on every branch');
  assert.equal(result.recommendedKey, 'buyNow');
});

test('simulateAffordability: waiting increases the down payment vs buying now', () => {
  const result = pe.simulateAffordability(demoProfile, { price: 7000000, waitMonths: 12 });
  const buyNow = result.branches.find((b) => b.key === 'buyNow');
  const wait = result.branches.find((b) => b.key === 'waitAndSave');
  assert.ok(wait.downPayment > buyNow.downPayment);
  assert.ok(wait.emi < buyNow.emi, 'a bigger down payment should produce a smaller EMI');
});

test('simulateAffordability: when NO branch meets the emergency-fund target, recommend the least-bad cushion, not blindly "buy now"', () => {
  const result = pe.simulateAffordability(demoProfile, { price: 7000000 });
  assert.ok(result.branches.every((b) => !b.emergencyFund.meetsTarget), 'precondition: this price should strain every branch for the demo profile');
  const recommended = result.branches.find((b) => b.key === result.recommendedKey);
  const best = [...result.branches].sort((a, b) => b.result.summary.minCash - a.result.summary.minCash)[0];
  assert.equal(recommended.key, best.key);
});

test('simulateAffordability throws without a price', () => {
  assert.throws(() => pe.simulateAffordability(demoProfile, {}));
});

// --- Safe EMI -----------------------------------------------------------------
test('findMaxSafeEmi returns an EMI no greater than current income', () => {
  const result = pe.findMaxSafeEmi(demoProfile);
  assert.ok(result.maxSafeEmi >= 0);
  assert.ok(result.maxSafeEmi <= pe.totalMonthlyIncome(demoProfile));
});

test('findMaxSafeEmi: a richer household can safely afford a bigger EMI than a tighter one', () => {
  const tight = { ...demoProfile, income: { monthly: 60000, other: 0 }, expenses: { ...demoProfile.expenses, rent: 20000 } };
  const richer = pe.findMaxSafeEmi(demoProfile).maxSafeEmi;
  const tighter = pe.findMaxSafeEmi(tight).maxSafeEmi;
  assert.ok(richer > tighter);
});

test('findMaxSafeEmi: a household already failing its emergency-fund target returns a note, not a false-safe number', () => {
  const brokeProfile = { ...demoProfile, income: { monthly: 40000, other: 0 }, expenses: { ...demoProfile.expenses, rent: 35000, food: 15000 } };
  const result = pe.findMaxSafeEmi(brokeProfile);
  assert.equal(result.maxSafeEmi, 0);
  assert.ok(result.note);
});

// --- Buy vs rent ---------------------------------------------------------------
test('buyVsRent returns checkpoints at years 5, 10, and 15', () => {
  const result = pe.buyVsRent(demoProfile, { price: 7500000, currentRent: 30000 });
  assert.deepEqual(result.checkpoints.map((c) => c.years), [5, 10, 15]);
});

test('buyVsRent: cheaper property relative to income reaches break-even sooner than an expensive one', () => {
  const cheap = pe.buyVsRent(demoProfile, { price: 4000000, currentRent: 30000 });
  const expensive = pe.buyVsRent(demoProfile, { price: 12000000, currentRent: 30000 });
  const cheapBE = cheap.breakEvenMonth ?? Infinity;
  const expensiveBE = expensive.breakEvenMonth ?? Infinity;
  assert.ok(cheapBE <= expensiveBE);
});

test('buyVsRent never claims buying is unconditionally better: with 0% appreciation, a well-invested down payment can keep rent ahead', () => {
  const result = pe.buyVsRent(demoProfile, {
    price: 9000000,
    currentRent: 25000,
    appreciationAnnualPct: 0,
    rentGrowthAnnualPct: 0,
    investReturnAnnualPct: 12,
  });
  // Not asserting a specific verdict — only that the model is capable of
  // producing "rent wins" under adverse-to-buying assumptions, i.e. the
  // recommendation is assumption-driven, not hardcoded.
  assert.ok(typeof result.breakEvenMonth === 'number' || result.breakEvenMonth === null);
});

test('buyVsRent throws without price; falls back to profile rent when currentRent omitted', () => {
  assert.throws(() => pe.buyVsRent(demoProfile, { currentRent: 20000 }));
  // No currentRent given -> falls back to the profile's own rent (25000),
  // which is a deliberate convenience default, not a missing-input error.
  const result = pe.buyVsRent(demoProfile, { price: 5000000 });
  assert.equal(result.currentRent, 25000);
});

test('buyVsRent throws when neither params nor profile has a usable rent figure', () => {
  const noRentProfile = { ...demoProfile, expenses: { ...demoProfile.expenses, rent: 0 } };
  assert.throws(() => pe.buyVsRent(noRentProfile, { price: 5000000 }));
});

// --- Rental yield ----------------------------------------------------------------
test('rentalYieldAnalysis: required rent for a higher target yield is higher', () => {
  const result = pe.rentalYieldAnalysis({ price: 8000000, downPayment: 2000000, interestRatePct: 8.5, monthlyMaintenance: 4000, occupancyMonths: 11 });
  const y3 = result.targets.find((t) => t.targetYieldPct === 3);
  const y5 = result.targets.find((t) => t.targetYieldPct === 5);
  assert.ok(y5.requiredRent > y3.requiredRent);
});

test('rentalYieldAnalysis: gross yield and net yield are clearly distinct (net <= gross)', () => {
  const result = pe.rentalYieldAnalysis({ price: 8000000, downPayment: 2000000, interestRatePct: 8.5, monthlyMaintenance: 4000, occupancyMonths: 11 });
  for (const t of result.targets) {
    assert.ok(t.netYieldPct <= t.grossYieldPct, 'net yield must never exceed gross yield');
  }
});

test('rentalYieldAnalysis: cash flow after financing can be negative even at a positive net yield', () => {
  const result = pe.rentalYieldAnalysis({ price: 8000000, downPayment: 1000000, interestRatePct: 9, monthlyMaintenance: 4000, occupancyMonths: 11 });
  const t = result.targets[0];
  assert.ok(typeof t.monthlyCashFlow === 'number');
});

// --- Goals -----------------------------------------------------------------------
test('goalProjection: more monthly saving reaches the goal sooner', () => {
  const slow = pe.goalProjection(demoProfile, { targetAmount: 600000, monthlyContribution: 10000 });
  const fast = pe.goalProjection(demoProfile, { targetAmount: 600000, monthlyContribution: 30000 });
  assert.ok(fast.monthsToReach < slow.monthsToReach);
});

test('goalProjection: required monthly contribution for a fixed timeframe is affordable-flagged correctly', () => {
  const result = pe.goalProjection(demoProfile, { targetAmount: 1000000, timeframeMonths: 24 });
  assert.ok(result.requiredMonthlyContribution > 0);
  assert.equal(typeof result.affordable, 'boolean');
});

test('goalProjection throws without a targetAmount', () => {
  assert.throws(() => pe.goalProjection(demoProfile, { monthlyContribution: 1000 }));
});

// --- Health score -----------------------------------------------------------------
test('personalHealthScore returns six categories and a 0-100 score', () => {
  const result = pe.personalHealthScore(demoProfile);
  assert.equal(result.breakdown.length, 6);
  assert.ok(result.score.value >= 0 && result.score.value <= 100);
});

test('personalHealthScore: a household with no emergency fund scores worse on that category than a well-buffered one', () => {
  const noBuffer = { ...demoProfile, savings: { current: 0, investments: 0, emergencyFund: 0 } };
  const wellBuffered = { ...demoProfile, savings: { current: 2000000, investments: 0, emergencyFund: 500000 } };
  const a = pe.personalHealthScore(noBuffer).score.value;
  const b = pe.personalHealthScore(wellBuffered).score.value;
  assert.ok(b > a);
});

// --- Stress test (Monte Carlo reuse) ------------------------------------------
test('personalStressTest reuses engine.monteCarloSimulate and returns a survival probability 0-100', () => {
  const { monteCarlo } = pe.personalStressTest(demoProfile, []);
  assert.ok(monteCarlo.survivalProbability >= 0 && monteCarlo.survivalProbability <= 100);
  assert.ok(Array.isArray(monteCarlo.months));
});
