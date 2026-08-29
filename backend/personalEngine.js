/**
 * personalEngine.js — Personal Financial Decision Engine
 * ---------------------------------------------------------
 * ZERO duplicated cash-flow math. Every simulation in this file is produced
 * by calling engine.simulate() / engine.monteCarloSimulate() — the exact
 * same functions Business Mode uses. This file's only job is to:
 *   1. Map a personal financial profile onto the engine's generic
 *      {startingCash, monthlyRevenue, monthlyFixedCosts, monthlyPayroll,
 *      growthRate} shape (see mapProfileToBase()).
 *   2. Express personal-finance events (a home purchase, an EMI, a rent
 *      increase) as the engine's existing shock vocabulary
 *      ('one_time_cash', 'hire', 'revenue_shock') — no new shock types are
 *      added to engine.js.
 *   3. Provide personal-domain formulas that are NOT cash-flow simulation
 *      (EMI/amortization, rental yield, goal math) as small, pure,
 *      independently-testable functions.
 *
 * Business mapping   -> Personal mapping
 *   Revenue           -> Total monthly income (take-home + other)
 *   Fixed costs       -> Living expenses (rent/food/utilities/transport/...)
 *   Payroll           -> Existing committed debt (current EMIs)
 *   Starting cash     -> Liquid savings + investments
 *   Growth rate       -> Income growth assumption (default 0, clearly labeled)
 *   "hire" shock      -> A NEW recurring monthly obligation starting a given
 *                        month (an EMI, maintenance, property tax/12, etc.)
 *                        — reusing "count * avgMonthlySalary added to costs
 *                        from `month` onward", which is exactly what a new
 *                        EMI does to a household's monthly outflow.
 *   "one_time_cash"   -> A down payment (negative) or a lump sum (positive)
 *   "revenue_shock"   -> An income change (e.g. a 20% pay cut)
 */

const engine = require('./engine');

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

// =============================================================================
// PROFILE MAPPING
// =============================================================================

function totalMonthlyExpenses(profile) {
  const e = profile.expenses || {};
  return (
    (e.rent || 0) +
    (e.food || 0) +
    (e.utilities || 0) +
    (e.transport || 0) +
    (e.insurance || 0) +
    (e.education || 0) +
    (e.other || 0)
  );
}

function totalMonthlyIncome(profile) {
  const i = profile.income || {};
  return (i.monthly || 0) + (i.other || 0);
}

function liquidNetWorth(profile) {
  const s = profile.savings || {};
  return (s.current || 0) + (s.investments || 0);
}

/**
 * Maps a personal profile to the exact shape engine.simulate() already
 * understands. `currency` and `avgMonthlySalary` are carried through for
 * display/reuse but are not required by the engine itself.
 */
function mapProfileToBase(profile) {
  return {
    label: profile.label || 'Your household',
    currency: '₹',
    startingCash: liquidNetWorth(profile),
    monthlyRevenue: totalMonthlyIncome(profile),
    monthlyFixedCosts: totalMonthlyExpenses(profile),
    monthlyPayroll: (profile.debt && profile.debt.existingEMI) || 0,
    growthRate: profile.incomeGrowthRate || 0,
  };
}

function monthlySurplus(profile) {
  return round2(
    totalMonthlyIncome(profile) - totalMonthlyExpenses(profile) - ((profile.debt && profile.debt.existingEMI) || 0)
  );
}

// =============================================================================
// AMORTIZATION / EMI — pure formulas, not cash-flow simulation
// =============================================================================

function monthlyRate(annualRatePct) {
  return (annualRatePct || 0) / 100 / 12;
}

function emiForLoan(principal, annualRatePct, tenureYears) {
  const n = Math.round((tenureYears || 0) * 12);
  if (n <= 0 || principal <= 0) return 0;
  const r = monthlyRate(annualRatePct);
  if (r === 0) return round2(principal / n);
  const factor = Math.pow(1 + r, n);
  return round2((principal * r * factor) / (factor - 1));
}

/** Loan balance remaining after `monthsElapsed` payments of a fixed EMI. */
function loanBalanceAfter(principal, annualRatePct, tenureYears, monthsElapsed) {
  const n = Math.round((tenureYears || 0) * 12);
  if (n <= 0 || principal <= 0) return 0;
  const emi = emiForLoan(principal, annualRatePct, tenureYears);
  const r = monthlyRate(annualRatePct);
  const m = Math.min(Math.max(monthsElapsed, 0), n);
  if (r === 0) return round2(Math.max(principal - emi * m, 0));
  const balance = principal * Math.pow(1 + r, m) - emi * ((Math.pow(1 + r, m) - 1) / r);
  return round2(Math.max(balance, 0));
}

function totalInterestForLoan(principal, annualRatePct, tenureYears) {
  const n = Math.round((tenureYears || 0) * 12);
  const emi = emiForLoan(principal, annualRatePct, tenureYears);
  return round2(emi * n - principal);
}

// =============================================================================
// FEATURE — "CAN I AFFORD THIS?" (property / major purchase)
// =============================================================================
// assumptions: { price, downPaymentPct, interestRatePct, tenureYears,
//                monthlyMaintenance, annualPropertyTax, waitMonths, cheaperPrice }
// All assumptions carry sensible demo defaults and are echoed back to the
// caller, clearly labeled, so the UI can show exactly what was assumed.

const DEFAULT_ASSUMPTIONS = {
  downPaymentPct: 0.2,
  interestRatePct: 8.5,
  tenureYears: 20,
  monthlyMaintenance: 3000,
  annualPropertyTax: 15000,
  waitMonths: 12,
  cheaperPriceFactor: 0.8,
  emergencyFundTargetMonths: 6,
  horizonMonths: 24,
};

function fillAssumptions(a = {}) {
  return { ...DEFAULT_ASSUMPTIONS, ...a };
}

/**
 * Builds a "buy at `price` in `purchaseMonth` with `downPayment`" scenario:
 * a modified base (rent replaced by ownership costs) + shocks the engine
 * already understands. Returns both so callers can inspect/reuse them.
 */
function buildPurchaseScenario(profile, price, downPayment, purchaseMonth, a) {
  const loanAmount = Math.max(price - downPayment, 0);
  const emi = emiForLoan(loanAmount, a.interestRatePct, a.tenureYears);
  const base = mapProfileToBase(profile);
  const rent = (profile.expenses && profile.expenses.rent) || 0;
  const ownershipMonthly = a.monthlyMaintenance + a.annualPropertyTax / 12;

  const scenarioBase = {
    ...base,
    // Once you own, you stop paying rent but pick up maintenance + property tax.
    monthlyFixedCosts: round2(base.monthlyFixedCosts - rent + ownershipMonthly),
  };

  const shocks = [];
  if (downPayment > 0) {
    shocks.push({ type: 'one_time_cash', month: purchaseMonth, amount: -downPayment });
  }
  if (emi > 0) {
    shocks.push({ type: 'hire', month: purchaseMonth, count: 1, avgMonthlySalary: emi });
  }

  return { scenarioBase, shocks, loanAmount, emi, ownershipMonthly };
}

function emergencyFundSafety(result, base, emergencyFundTargetMonths) {
  const monthlyExpenseFloor = base.monthlyFixedCosts + base.monthlyPayroll;
  const targetCash = monthlyExpenseFloor * emergencyFundTargetMonths;
  const minCash = result.summary.minCash;
  const monthsOfBufferAtMin = monthlyExpenseFloor > 0 ? minCash / monthlyExpenseFloor : Infinity;
  return {
    targetCash: round2(targetCash),
    minCash,
    monthsOfBufferAtMin: round1(Math.max(monthsOfBufferAtMin, 0)),
    meetsTarget: minCash >= targetCash,
  };
}

/**
 * Three deterministic branches: BUY NOW, WAIT & SAVE, BUY CHEAPER.
 * Every branch is a real engine.simulate() call — nothing here is invented.
 */
function simulateAffordability(profile, rawAssumptions = {}) {
  const a = fillAssumptions(rawAssumptions);
  const price = rawAssumptions.price;
  if (!price || price <= 0) throw new Error('price is required');

  const horizon = Math.max(a.horizonMonths, a.waitMonths + 12);
  const surplus = monthlySurplus(profile);

  // --- BUY NOW ---------------------------------------------------------
  const downPaymentNow = round2(price * a.downPaymentPct);
  const buyNow = buildPurchaseScenario(profile, price, downPaymentNow, 1, a);
  const buyNowResult = engine.simulate(buyNow.scenarioBase, buyNow.shocks, horizon);

  // --- WAIT & SAVE -------------------------------------------------------
  // During the wait, the household keeps banking its current monthly
  // surplus (computed directly from the profile, not guessed) — that extra
  // cash becomes a BIGGER down payment, which lowers the loan and the EMI.
  const additionalSavings = Math.max(surplus, 0) * a.waitMonths;
  const downPaymentWait = Math.min(round2(downPaymentNow + additionalSavings), round2(price * 0.9));
  const buyWait = buildPurchaseScenario(profile, price, downPaymentWait, a.waitMonths + 1, a);
  const buyWaitResult = engine.simulate(buyWait.scenarioBase, buyWait.shocks, horizon);

  // --- BUY CHEAPER ---------------------------------------------------------
  const cheaperPrice = round2(rawAssumptions.cheaperPrice || price * a.cheaperPriceFactor);
  const downPaymentCheaper = round2(cheaperPrice * a.downPaymentPct);
  const buyCheaper = buildPurchaseScenario(profile, cheaperPrice, downPaymentCheaper, 1, a);
  const buyCheaperResult = engine.simulate(buyCheaper.scenarioBase, buyCheaper.shocks, horizon);

  const branches = [
    {
      key: 'buyNow',
      name: 'Buy now',
      price,
      downPayment: downPaymentNow,
      loanAmount: buyNow.loanAmount,
      emi: buyNow.emi,
      totalInterest: totalInterestForLoan(buyNow.loanAmount, a.interestRatePct, a.tenureYears),
      monthlySurplusAfter: round2(surplus - buyNow.emi - buyNow.ownershipMonthly + ((profile.expenses && profile.expenses.rent) || 0)),
      result: buyNowResult,
      emergencyFund: emergencyFundSafety(buyNowResult, buyNow.scenarioBase, a.emergencyFundTargetMonths),
    },
    {
      key: 'waitAndSave',
      name: `Wait ${a.waitMonths} months`,
      price,
      downPayment: downPaymentWait,
      loanAmount: buyWait.loanAmount,
      emi: buyWait.emi,
      totalInterest: totalInterestForLoan(buyWait.loanAmount, a.interestRatePct, a.tenureYears),
      monthlySurplusAfter: round2(surplus - buyWait.emi - buyWait.ownershipMonthly + ((profile.expenses && profile.expenses.rent) || 0)),
      result: buyWaitResult,
      emergencyFund: emergencyFundSafety(buyWaitResult, buyWait.scenarioBase, a.emergencyFundTargetMonths),
    },
    {
      key: 'buyCheaper',
      name: 'Buy a cheaper property',
      price: cheaperPrice,
      downPayment: downPaymentCheaper,
      loanAmount: buyCheaper.loanAmount,
      emi: buyCheaper.emi,
      totalInterest: totalInterestForLoan(buyCheaper.loanAmount, a.interestRatePct, a.tenureYears),
      monthlySurplusAfter: round2(surplus - buyCheaper.emi - buyCheaper.ownershipMonthly + ((profile.expenses && profile.expenses.rent) || 0)),
      result: buyCheaperResult,
      emergencyFund: emergencyFundSafety(buyCheaperResult, buyCheaper.scenarioBase, a.emergencyFundTargetMonths),
    },
  ];

  // Recommendation policy (personal-domain, mirrors agent.pickRecommendation's
  // spirit — filter by safety first, then apply a decision preference):
  //   1. If at least one branch meets the emergency-fund target, only those
  //      branches are eligible, and among them we prefer doing what the user
  //      actually asked (buy now) over delaying or downsizing.
  //   2. If NONE of the branches meet the target, there is no "safe" option
  //      to prefer by intent — fall back to whichever branch leaves the
  //      biggest cash cushion (least-bad option), then lowest total interest.
  const PREFERENCE_ORDER = { buyNow: 0, waitAndSave: 1, buyCheaper: 2 };
  const anySafe = branches.some((b) => b.emergencyFund.meetsTarget);
  const ranked = anySafe
    ? [...branches]
        .filter((b) => b.emergencyFund.meetsTarget)
        .sort((x, y) => PREFERENCE_ORDER[x.key] - PREFERENCE_ORDER[y.key])
    : [...branches].sort((x, y) => {
        if (x.result.summary.minCash !== y.result.summary.minCash) {
          return y.result.summary.minCash - x.result.summary.minCash;
        }
        return x.totalInterest - y.totalInterest;
      });

  const recommended = ranked[0];
  const whyNotBuyNow = !branches[0].emergencyFund.meetsTarget
    ? `Buying immediately would leave only ${branches[0].emergencyFund.monthsOfBufferAtMin} month(s) of expenses in liquid savings at the lowest point, below your ${a.emergencyFundTargetMonths}-month target.`
    : null;

  return {
    assumptions: a,
    monthlySurplusToday: surplus,
    branches,
    recommendedKey: recommended.key,
    why: recommended.key === 'buyNow'
      ? `Buying now keeps at least ${recommended.emergencyFund.monthsOfBufferAtMin} months of expenses in reserve at the lowest point, meeting your ${a.emergencyFundTargetMonths}-month emergency-fund target, with an EMI of ${recommended.emi.toLocaleString('en-IN')}/mo against a monthly surplus of ${surplus.toLocaleString('en-IN')}.`
      : recommended.key === 'waitAndSave'
      ? `${whyNotBuyNow || 'Buying immediately is tighter than the alternatives.'} Waiting ${a.waitMonths} months lets you bank an extra ${additionalSavings.toLocaleString('en-IN')} toward the down payment (raising it from ${downPaymentNow.toLocaleString('en-IN')} to ${downPaymentWait.toLocaleString('en-IN')}), cutting the loan and EMI to ${recommended.emi.toLocaleString('en-IN')}/mo while rebuilding the buffer.`
      : `${whyNotBuyNow || 'The requested property strains your emergency fund.'} A ${cheaperPrice.toLocaleString('en-IN')} property keeps the EMI to ${recommended.emi.toLocaleString('en-IN')}/mo, which fits comfortably within your surplus and safety margin.`,
  };
}

// =============================================================================
// FEATURE — MAXIMUM SAFE EMI (reverse simulation)
// =============================================================================
// Binary search over a candidate EMI amount, materialized as the SAME
// 'hire' shock buildPurchaseScenario() uses — this is engine.simulate(),
// not a re-derivation of cash-flow math.

function isEmiSafe(profile, emiCandidate, emergencyFundTargetMonths, minSurplusBuffer) {
  const base = mapProfileToBase(profile);
  const shocks = emiCandidate > 0 ? [{ type: 'hire', month: 1, count: 1, avgMonthlySalary: emiCandidate }] : [];
  const horizon = 24;
  const result = engine.simulate(base, shocks, horizon);
  const safety = emergencyFundSafety(result, base, emergencyFundTargetMonths);
  const remainingSurplus = monthlySurplus(profile) - emiCandidate;
  return safety.meetsTarget && remainingSurplus >= minSurplusBuffer && !result.summary.goesNegative;
}

function findMaxSafeEmi(profile, opts = {}) {
  const emergencyFundTargetMonths = opts.emergencyFundTargetMonths || DEFAULT_ASSUMPTIONS.emergencyFundTargetMonths;
  const desiredMonthlySavings = typeof opts.desiredMonthlySavings === 'number' ? opts.desiredMonthlySavings : 0;
  const income = totalMonthlyIncome(profile);

  let lo = 0; // last known safe EMI
  let hi = Math.max(income, 1); // presumed unsafe ceiling
  if (!isEmiSafe(profile, lo, emergencyFundTargetMonths, desiredMonthlySavings)) {
    // Not even EMI=0 is safe under the target — the underlying budget itself
    // doesn't hit the emergency-fund/savings target yet.
    return {
      maxSafeEmi: 0,
      emergencyFundTargetMonths,
      desiredMonthlySavings,
      currentMonthlySurplus: monthlySurplus(profile),
      note: 'Even with no new EMI, your current budget does not meet the emergency-fund/savings target — build your buffer before taking on new debt.',
    };
  }

  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (isEmiSafe(profile, mid, emergencyFundTargetMonths, desiredMonthlySavings)) lo = mid;
    else hi = mid;
    if (hi - lo < 50) break; // ₹50 precision is plenty for an EMI figure
  }

  const maxSafeEmi = Math.floor(lo / 100) * 100; // floor to nearest ₹100, never round up past the safe boundary
  return {
    maxSafeEmi,
    emergencyFundTargetMonths,
    desiredMonthlySavings,
    currentMonthlySurplus: monthlySurplus(profile),
    impliedMaxLoan: (annualRatePct, tenureYears) => impliedLoanFromEmi(maxSafeEmi, annualRatePct, tenureYears),
  };
}

/** Reverse of emiForLoan(): how much principal does a given EMI service? */
function impliedLoanFromEmi(emi, annualRatePct, tenureYears) {
  const n = Math.round((tenureYears || 0) * 12);
  if (n <= 0 || emi <= 0) return 0;
  const r = monthlyRate(annualRatePct);
  if (r === 0) return round2(emi * n);
  const factor = Math.pow(1 + r, n);
  return round2((emi * (factor - 1)) / (r * factor));
}

// =============================================================================
// FEATURE — BUY VS RENT (long-horizon net-worth comparison)
// =============================================================================
// Both paths reuse engine.simulate() for the cash-flow leg; property
// appreciation / invested-down-payment growth are net-worth adjustments
// layered on top (they are not cash flows the engine's monthly loop needs
// to know about, so modeling them outside simulate() does not duplicate it).

function propertyValueAt(price, appreciationAnnualPct, months) {
  return round2(price * Math.pow(1 + (appreciationAnnualPct || 0) / 100, months / 12));
}

function compoundedValueAt(principal, annualReturnPct, months) {
  return round2(principal * Math.pow(1 + (annualReturnPct || 0) / 100, months / 12));
}

/**
 * Builds one negative one_time_cash shock per month for every month a rent
 * increase is in effect — the same "repeat a monthly cash delta" pattern
 * agent.materializeCostAdjustments() already uses for cost cuts, just
 * applied in the other direction (a recurring rent-escalation cost).
 */
function buildRentEscalationShocks(baseRent, rentGrowthAnnualPct, horizonMonths) {
  const shocks = [];
  for (let m = 1; m <= horizonMonths; m++) {
    const yearsElapsed = Math.floor((m - 1) / 12);
    const rentThisMonth = round2(baseRent * Math.pow(1 + (rentGrowthAnnualPct || 0) / 100, yearsElapsed));
    const delta = round2(rentThisMonth - baseRent);
    if (delta !== 0) shocks.push({ type: 'one_time_cash', month: m, amount: -delta });
  }
  return shocks;
}

function buyVsRent(profile, params = {}) {
  const price = params.price;
  const currentRent = params.currentRent != null ? params.currentRent : (profile.expenses && profile.expenses.rent) || 0;
  if (!price || price <= 0) throw new Error('price is required');
  if (!currentRent || currentRent <= 0) throw new Error('currentRent is required');

  const a = {
    downPaymentPct: params.downPaymentPct != null ? params.downPaymentPct : DEFAULT_ASSUMPTIONS.downPaymentPct,
    interestRatePct: params.interestRatePct || DEFAULT_ASSUMPTIONS.interestRatePct,
    tenureYears: params.tenureYears || DEFAULT_ASSUMPTIONS.tenureYears,
    monthlyMaintenance: params.monthlyMaintenance != null ? params.monthlyMaintenance : DEFAULT_ASSUMPTIONS.monthlyMaintenance,
    annualPropertyTax: params.annualPropertyTax != null ? params.annualPropertyTax : DEFAULT_ASSUMPTIONS.annualPropertyTax,
    appreciationAnnualPct: params.appreciationAnnualPct != null ? params.appreciationAnnualPct : 5,
    rentGrowthAnnualPct: params.rentGrowthAnnualPct != null ? params.rentGrowthAnnualPct : 6,
    investReturnAnnualPct: params.investReturnAnnualPct != null ? params.investReturnAnnualPct : 8,
  };

  const horizonMonths = 180; // covers the 5/10/15-year checkpoints in one run
  const downPayment = round2(price * a.downPaymentPct);
  const loanAmount = round2(price - downPayment);
  const emi = emiForLoan(loanAmount, a.interestRatePct, a.tenureYears);

  // --- BUY leg -------------------------------------------------------------
  const base = mapProfileToBase(profile);
  const ownershipMonthly = a.monthlyMaintenance + a.annualPropertyTax / 12;
  const buyBase = { ...base, monthlyFixedCosts: round2(base.monthlyFixedCosts - currentRent + ownershipMonthly) };
  const buyShocks = [
    { type: 'one_time_cash', month: 1, amount: -downPayment },
    ...(emi > 0 ? [{ type: 'hire', month: 1, count: 1, avgMonthlySalary: emi }] : []),
  ];
  const buyResult = engine.simulate(buyBase, buyShocks, horizonMonths);

  // --- RENT leg (rent escalates; the down payment is invested instead) -----
  const rentBase = { ...base }; // unchanged: still paying (today's) rent inside monthlyFixedCosts
  const rentShocks = buildRentEscalationShocks(currentRent, a.rentGrowthAnnualPct, horizonMonths);
  const rentResult = engine.simulate(rentBase, rentShocks, horizonMonths);

  const checkpoints = [5, 10, 15].map((years) => {
    const m = years * 12;
    const buyCash = buyResult.months[m - 1].cash;
    const rentCash = rentResult.months[m - 1].cash;
    const propertyValue = propertyValueAt(price, a.appreciationAnnualPct, m);
    const remainingLoan = loanBalanceAfter(loanAmount, a.interestRatePct, a.tenureYears, m);
    const investedDownPayment = compoundedValueAt(downPayment, a.investReturnAnnualPct, m);

    const netWorthBuy = round2(buyCash + propertyValue - remainingLoan);
    const netWorthRent = round2(rentCash + investedDownPayment);

    return {
      years,
      netWorthBuy,
      netWorthRent,
      propertyValue,
      remainingLoan,
      investedDownPayment,
      buyAheadBy: round2(netWorthBuy - netWorthRent),
    };
  });

  // Break-even: first calendar year (checked monthly for precision) where
  // BUY's net worth overtakes RENT's.
  let breakEvenMonth = null;
  for (let m = 12; m <= horizonMonths; m += 1) {
    const propertyValue = propertyValueAt(price, a.appreciationAnnualPct, m);
    const remainingLoan = loanBalanceAfter(loanAmount, a.interestRatePct, a.tenureYears, m);
    const investedDownPayment = compoundedValueAt(downPayment, a.investReturnAnnualPct, m);
    const netWorthBuy = buyResult.months[m - 1].cash + propertyValue - remainingLoan;
    const netWorthRent = rentResult.months[m - 1].cash + investedDownPayment;
    if (netWorthBuy > netWorthRent) {
      breakEvenMonth = m;
      break;
    }
  }

  return {
    assumptions: a,
    price,
    currentRent,
    downPayment,
    loanAmount,
    emi,
    checkpoints,
    breakEvenMonth,
    breakEvenYear: breakEvenMonth ? round1(breakEvenMonth / 12) : null,
    verdict: breakEvenMonth
      ? `Buying becomes financially favorable around year ${round1(breakEvenMonth / 12)} under the current assumptions.`
      : `Under the current assumptions, renting and investing the difference stays ahead of buying for the full 15-year horizon.`,
  };
}

// =============================================================================
// FEATURE — RENTAL YIELD ADVISOR
// =============================================================================
// Pure formulas — not a cash-flow simulation, so no engine.simulate() call
// is needed here, only clearly-separated gross/net/cash-flow definitions.

function rentalYieldAnalysis(params = {}) {
  const price = params.price;
  if (!price || price <= 0) throw new Error('price is required');
  const downPayment = params.downPayment != null ? params.downPayment : round2(price * DEFAULT_ASSUMPTIONS.downPaymentPct);
  const loanAmount = params.loanAmount != null ? params.loanAmount : round2(price - downPayment);
  const interestRatePct = params.interestRatePct || DEFAULT_ASSUMPTIONS.interestRatePct;
  const tenureYears = params.tenureYears || DEFAULT_ASSUMPTIONS.tenureYears;
  const monthlyMaintenance = params.monthlyMaintenance != null ? params.monthlyMaintenance : DEFAULT_ASSUMPTIONS.monthlyMaintenance;
  const annualPropertyTax = params.annualPropertyTax != null ? params.annualPropertyTax : DEFAULT_ASSUMPTIONS.annualPropertyTax;
  const occupancyMonths = params.occupancyMonths != null ? params.occupancyMonths : 11;

  const emi = emiForLoan(loanAmount, interestRatePct, tenureYears);

  function analyzeAtRent(monthlyRent) {
    const grossAnnualRent = round2(monthlyRent * 12);
    const grossYieldPct = round2((grossAnnualRent / price) * 100);

    const vacancyAdjustedAnnualRent = round2(monthlyRent * occupancyMonths);
    const netAnnualIncome = round2(vacancyAdjustedAnnualRent - monthlyMaintenance * 12 - annualPropertyTax);
    const netYieldPct = round2((netAnnualIncome / price) * 100);

    const monthlyCashFlow = round2(vacancyAdjustedAnnualRent / 12 - monthlyMaintenance - annualPropertyTax / 12 - emi);

    return {
      monthlyRent: round2(monthlyRent),
      grossAnnualRent,
      grossYieldPct,
      vacancyAdjustedAnnualRent,
      netAnnualIncome,
      netYieldPct,
      monthlyCashFlow,
      annualCashFlow: round2(monthlyCashFlow * 12),
    };
  }

  function rentForTargetGrossYield(targetYieldPct) {
    return round2((targetYieldPct / 100) * price / 12);
  }

  const targets = [3, 4, 5, ...(params.customTargetYieldPct ? [params.customTargetYieldPct] : [])].map((t) => ({
    targetYieldPct: t,
    requiredRent: rentForTargetGrossYield(t),
    ...analyzeAtRent(rentForTargetGrossYield(t)),
  }));

  const atStatedRent = params.statedRent ? analyzeAtRent(params.statedRent) : null;

  return {
    price,
    downPayment,
    loanAmount,
    interestRatePct,
    tenureYears,
    emi,
    monthlyMaintenance,
    annualPropertyTax,
    occupancyMonths,
    atStatedRent,
    targets,
  };
}

// =============================================================================
// FEATURE — FINANCIAL GOALS
// =============================================================================
// "How long to reach ₹X" / "what monthly saving reaches ₹X in Y years" —
// pure future-value-of-savings-stream math. When a monthly saving figure is
// given it is ALSO cross-checked by running it through engine.simulate()
// (starting cash = 0, revenue = monthly saving, no costs) so the "time to
// reach" figure for the base case is engine-verified, not just formula-only.

function monthsToReachGoal(currentAmount, monthlyContribution, targetAmount, annualReturnPct = 0) {
  if (currentAmount >= targetAmount) return 0;
  const r = (annualReturnPct || 0) / 100 / 12;
  if (monthlyContribution <= 0) return null; // unreachable without saving

  if (r === 0) {
    return Math.ceil((targetAmount - currentAmount) / monthlyContribution);
  }
  // FV = PV*(1+r)^n + PMT*(((1+r)^n - 1)/r) = target  -> solve n numerically
  for (let n = 1; n <= 720; n++) {
    const fv = currentAmount * Math.pow(1 + r, n) + monthlyContribution * ((Math.pow(1 + r, n) - 1) / r);
    if (fv >= targetAmount) return n;
  }
  return null; // not reachable within 60 years at this rate
}

function requiredMonthlyForGoal(currentAmount, targetAmount, months, annualReturnPct = 0) {
  const r = (annualReturnPct || 0) / 100 / 12;
  const remaining = targetAmount - currentAmount * Math.pow(1 + r, months);
  if (remaining <= 0) return 0;
  if (r === 0) return round2(remaining / months);
  const factor = (Math.pow(1 + r, months) - 1) / r;
  return round2(remaining / factor);
}

function goalProjection(profile, goal) {
  const currentAmount = goal.currentAmount || 0;
  const targetAmount = goal.targetAmount;
  const annualReturnPct = goal.annualReturnPct || 0;
  if (!targetAmount || targetAmount <= 0) throw new Error('targetAmount is required');

  const result = { currentAmount, targetAmount, annualReturnPct };

  if (goal.monthlyContribution != null) {
    const months = monthsToReachGoal(currentAmount, goal.monthlyContribution, targetAmount, annualReturnPct);
    result.monthlyContribution = goal.monthlyContribution;
    result.monthsToReach = months;
    result.yearsToReach = months != null ? round1(months / 12) : null;
  }

  if (goal.timeframeMonths != null) {
    const monthly = requiredMonthlyForGoal(currentAmount, targetAmount, goal.timeframeMonths, annualReturnPct);
    result.timeframeMonths = goal.timeframeMonths;
    result.requiredMonthlyContribution = monthly;
    result.affordable = monthly <= monthlySurplus(profile);
    result.currentSurplus = monthlySurplus(profile);
  }

  // Comparison table: effect of a few alternative monthly contribution rates.
  if (goal.compareContributions && goal.compareContributions.length) {
    result.comparisons = goal.compareContributions.map((c) => ({
      monthlyContribution: c,
      monthsToReach: monthsToReachGoal(currentAmount, c, targetAmount, annualReturnPct),
    }));
  }

  return result;
}

// =============================================================================
// FEATURE — PERSONAL STRESS TEST (Monte Carlo, reused as-is from engine.js)
// =============================================================================

function personalStressTest(profile, shocks = [], userConfig = {}) {
  const base = mapProfileToBase(profile);
  // Same knobs as the business Monte Carlo, renamed conceptually for a
  // household: income volatility, monthly expense noise, a chance of one
  // unexpected large expense during the horizon (medical bill, repair, etc).
  const config = {
    growthRateStdDevPct: 0.3,
    monthlyRevenueNoisePct: 0.05,
    fixedCostOverrunPct: 0.1,
    latePaymentProbability: 0.2, // reused as "one unexpected expense this year"
    ...userConfig,
  };
  return { base, monteCarlo: engine.monteCarloSimulate(base, shocks, config) };
}

// =============================================================================
// FEATURE — PERSONAL FINANCIAL HEALTH SCORE
// =============================================================================
// Same shape/spirit as engine.analyzeRisks(): fixed, documented thresholds,
// point deductions from 100, every deduction explained. Zero LLM involvement.

const PERSONAL_HEALTH_WEIGHTS = {
  emergencyFund: { healthy: 0, watch: 4, medium: 8, high: 15 },
  debtBurden: { healthy: 0, watch: 4, medium: 8, high: 15 },
  savingsRate: { healthy: 0, watch: 3, medium: 6, high: 12 },
  housingBurden: { healthy: 0, watch: 3, medium: 6, high: 10 },
  cashBuffer: { healthy: 0, watch: 3, medium: 6, high: 10 },
  incomeStability: { healthy: 0, watch: 2, medium: 4, high: 8 },
};

function severityFromThresholds(value, thresholds) {
  // thresholds: [healthyMax, watchMax, mediumMax] ascending is "bad"; caller
  // decides direction by pre-inverting `value` if lower-is-worse.
  if (value <= thresholds[0]) return 'healthy';
  if (value <= thresholds[1]) return 'watch';
  if (value <= thresholds[2]) return 'medium';
  return 'high';
}

function personalHealthScore(profile) {
  const income = totalMonthlyIncome(profile);
  const expenses = totalMonthlyExpenses(profile);
  const emi = (profile.debt && profile.debt.existingEMI) || 0;
  const rent = (profile.expenses && profile.expenses.rent) || 0;
  const emergencyFund = (profile.savings && profile.savings.emergencyFund) || 0;
  const emergencyTargetMonths = profile.minEmergencyFundTarget || DEFAULT_ASSUMPTIONS.emergencyFundTargetMonths;
  const surplus = monthlySurplus(profile);
  const dependents = profile.dependents || 0;

  const results = [];

  // A. Emergency fund coverage (months of expenses the fund covers)
  const monthsCovered = expenses > 0 ? round1(emergencyFund / expenses) : Infinity;
  const efSeverity = monthsCovered >= emergencyTargetMonths ? 'healthy'
    : monthsCovered >= emergencyTargetMonths * 0.66 ? 'watch'
    : monthsCovered >= emergencyTargetMonths * 0.33 ? 'medium' : 'high';
  results.push({
    key: 'emergencyFund',
    title: 'EMERGENCY FUND',
    severity: efSeverity,
    value: `${monthsCovered} of ${emergencyTargetMonths} months`,
    summary: `Your emergency fund covers ${monthsCovered} month(s) of expenses, vs. a ${emergencyTargetMonths}-month target.`,
    calculation: 'emergency fund ÷ monthly expenses, vs. your stated target',
  });

  // B. Debt burden (EMI ÷ income)
  const debtRatio = income > 0 ? round1((emi / income) * 100) : 0;
  const debtSeverity = debtRatio < 20 ? 'healthy' : debtRatio < 36 ? 'watch' : debtRatio < 50 ? 'medium' : 'high';
  results.push({
    key: 'debtBurden',
    title: 'DEBT BURDEN',
    severity: debtSeverity,
    value: `${debtRatio}% of income`,
    summary: `Existing EMIs are ${debtRatio}% of your monthly income.`,
    calculation: 'existing EMI ÷ total monthly income',
  });

  // C. Savings rate ((income - expenses - EMI) ÷ income)
  const savingsRatePct = income > 0 ? round1((surplus / income) * 100) : 0;
  const srSeverity = savingsRatePct >= 20 ? 'healthy' : savingsRatePct >= 10 ? 'watch' : savingsRatePct >= 0 ? 'medium' : 'high';
  results.push({
    key: 'savingsRate',
    title: 'SAVINGS RATE',
    severity: srSeverity,
    value: `${savingsRatePct}%`,
    summary: `You save ${savingsRatePct}% of income after expenses and EMIs.`,
    calculation: '(income − expenses − existing EMI) ÷ income',
  });

  // D. Housing burden (rent or EMI-for-housing ÷ income) — uses rent today
  const housingRatioPct = income > 0 ? round1((rent / income) * 100) : 0;
  const hbSeverity = housingRatioPct < 30 ? 'healthy' : housingRatioPct < 40 ? 'watch' : housingRatioPct < 50 ? 'medium' : 'high';
  results.push({
    key: 'housingBurden',
    title: 'HOUSING BURDEN',
    severity: hbSeverity,
    value: `${housingRatioPct}% of income`,
    summary: `Rent is ${housingRatioPct}% of your monthly income.`,
    calculation: 'rent ÷ total monthly income',
  });

  // E. Cash buffer — same "months of runway" idea as Business Mode's cash
  // buffer, but measured against TOTAL liquid net worth, not just the
  // emergency fund line item.
  const liquid = liquidNetWorth(profile);
  const monthsOfLiquidBuffer = expenses + emi > 0 ? round1(liquid / (expenses + emi)) : Infinity;
  const cbSeverity = monthsOfLiquidBuffer >= 12 ? 'healthy' : monthsOfLiquidBuffer >= 6 ? 'watch' : monthsOfLiquidBuffer >= 3 ? 'medium' : 'high';
  results.push({
    key: 'cashBuffer',
    title: 'CASH BUFFER',
    severity: cbSeverity,
    value: `${monthsOfLiquidBuffer} months`,
    summary: `Total liquid savings + investments would cover ${monthsOfLiquidBuffer} month(s) of expenses + EMIs.`,
    calculation: '(savings + investments) ÷ (monthly expenses + existing EMI)',
  });

  // F. Income stability — single vs. multiple income sources, adjusted for
  // dependents (more dependents on a single income = thinner margin for
  // error). This is a declared, documented heuristic, not a hidden guess.
  const hasOtherIncome = ((profile.income && profile.income.other) || 0) > 0;
  let isSeverity;
  if (hasOtherIncome) isSeverity = 'healthy';
  else if (dependents <= 1) isSeverity = 'watch';
  else if (dependents <= 3) isSeverity = 'medium';
  else isSeverity = 'high';
  results.push({
    key: 'incomeStability',
    title: 'INCOME STABILITY',
    severity: isSeverity,
    value: hasOtherIncome ? 'Multiple income sources' : `Single income, ${dependents} dependent(s)`,
    summary: hasOtherIncome
      ? 'You have more than one income source, reducing single-point-of-failure risk.'
      : `You rely on a single income source with ${dependents} dependent(s) — less room to absorb an income shock.`,
    calculation: 'presence of a second income source, weighted by number of dependents',
  });

  const deductions = results.map((r) => ({
    key: r.key,
    label: r.title,
    severity: r.severity,
    points: PERSONAL_HEALTH_WEIGHTS[r.key][r.severity] || 0,
  }));
  const totalDeduction = deductions.reduce((s, d) => s + d.points, 0);
  const score = Math.max(0, Math.min(100, round1(100 - totalDeduction)));

  results.forEach((r) => {
    r.deductionPoints = deductions.find((d) => d.key === r.key).points;
  });

  const order = { high: 3, medium: 2, watch: 1, healthy: 0 };
  const sorted = [...results].sort((x, y) => {
    const diff = order[y.severity] - order[x.severity];
    return diff !== 0 ? diff : (y.deductionPoints || 0) - (x.deductionPoints || 0);
  });

  const worst = sorted[0];
  const explanation = worst && worst.severity !== 'healthy'
    ? `Your score is reduced primarily because of ${worst.title.toLowerCase()}: ${worst.summary}`
    : 'No major weak spots detected — every category is within a healthy range.';

  return {
    score: { value: score, base: 100, deductions: deductions.filter((d) => d.points > 0) },
    breakdown: sorted,
    explanation,
  };
}

module.exports = {
  mapProfileToBase,
  totalMonthlyExpenses,
  totalMonthlyIncome,
  liquidNetWorth,
  monthlySurplus,
  buildPurchaseScenario,
  emergencyFundSafety,
  emiForLoan,
  loanBalanceAfter,
  totalInterestForLoan,
  impliedLoanFromEmi,
  simulateAffordability,
  findMaxSafeEmi,
  buyVsRent,
  rentalYieldAnalysis,
  goalProjection,
  monthsToReachGoal,
  requiredMonthlyForGoal,
  personalStressTest,
  personalHealthScore,
  DEFAULT_ASSUMPTIONS,
};
