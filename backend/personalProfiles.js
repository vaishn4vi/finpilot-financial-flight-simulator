/**
 * personalProfiles.js — demo personal financial profiles for Personal Mode.
 * Structured exactly the way personalEngine.mapProfileToBase() expects, so
 * a real user profile (entered via the form) has the identical shape.
 */

const PERSONAL_PROFILES = {
  demo_household: {
    id: 'demo_household',
    label: 'Demo household (2 dependents)',
    description: 'A dual-income household renting in a metro, with a healthy but not huge savings cushion — the profile used throughout the Personal Mode demo.',
    income: { monthly: 150000, other: 10000 },
    savings: { current: 1200000, investments: 0, emergencyFund: 300000 },
    expenses: { rent: 25000, food: 12000, utilities: 4000, transport: 6000, insurance: 3000, education: 0, other: 5000 },
    debt: { existingEMI: 8000, outstandingLoans: 0, interestRate: 0, remainingTenureYears: 0 },
    dependents: 2,
    minEmergencyFundTarget: 6,
    desiredMonthlySavings: 25000,
    riskTolerance: 'moderate',
    incomeGrowthRate: 0,
  },
  single_saver: {
    id: 'single_saver',
    label: 'Single income, early career',
    description: 'A single earner early in their career with lower expenses and a smaller cushion — useful for showing a tighter affordability case.',
    income: { monthly: 80000, other: 0 },
    savings: { current: 400000, investments: 50000, emergencyFund: 150000 },
    expenses: { rent: 20000, food: 8000, utilities: 2500, transport: 4000, insurance: 1500, education: 0, other: 4000 },
    debt: { existingEMI: 0, outstandingLoans: 0, interestRate: 0, remainingTenureYears: 0 },
    dependents: 0,
    minEmergencyFundTarget: 6,
    desiredMonthlySavings: 15000,
    riskTolerance: 'conservative',
    incomeGrowthRate: 0.01,
  },
  dual_income_investor: {
    id: 'dual_income_investor',
    label: 'Dual income, established',
    description: 'An established dual-income household with meaningful investments — useful for showing rental/investment-property analysis.',
    income: { monthly: 280000, other: 40000 },
    savings: { current: 2500000, investments: 3000000, emergencyFund: 900000 },
    expenses: { rent: 45000, food: 20000, utilities: 6000, transport: 12000, insurance: 8000, education: 15000, other: 10000 },
    debt: { existingEMI: 15000, outstandingLoans: 0, interestRate: 0, remainingTenureYears: 0 },
    dependents: 2,
    minEmergencyFundTarget: 6,
    desiredMonthlySavings: 60000,
    riskTolerance: 'aggressive',
    incomeGrowthRate: 0.005,
  },
};

function getPersonalProfile(id) {
  return PERSONAL_PROFILES[id] || null;
}

function listPersonalProfiles() {
  return Object.values(PERSONAL_PROFILES).map((p) => ({ id: p.id, label: p.label, description: p.description }));
}

function defaultPersonalProfile() {
  return PERSONAL_PROFILES.demo_household;
}

module.exports = { PERSONAL_PROFILES, getPersonalProfile, listPersonalProfiles, defaultPersonalProfile };
