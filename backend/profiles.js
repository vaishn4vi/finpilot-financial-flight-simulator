/**
 * profiles.js — Mock pre-loaded business profiles.
 * In a real integration, these would be replaced/augmented by pulling
 * live figures from Razorpay's transaction & settlement data
 * (see README for the integration sketch).
 */

const PROFILES = {
  d2c_startup: {
    id: 'd2c_startup',
    label: 'D2C Startup (Skincare Brand)',
    description: 'Early-stage direct-to-consumer brand, strong growth, thin margins, seasonal spikes.',
    currency: '₹',
    startingCash: 4200000,       // ₹42L in the bank
    monthlyRevenue: 1800000,     // ₹18L/mo
    monthlyFixedCosts: 650000,   // rent, ads, ops
    monthlyPayroll: 900000,      // 12 people
    growthRate: 0.045,           // 4.5%/mo organic growth
    costGrowthRate: 0.02,        // demo assumption: fixed costs + payroll drift ~2%/mo (ad spend/tooling scales with growth)
    paymentTermsDays: 7,         // mostly prepaid/COD, short cycle
    avgMonthlySalary: 65000,
    customerConcentration: 0.15, // biggest single wholesale customer ~15% of revenue
  },
  services_smb: {
    id: 'services_smb',
    label: 'Services SMB (IT Consulting)',
    description: 'B2B services firm, few large clients, long payment cycles, steady but slow growth.',
    currency: '₹',
    startingCash: 9000000,       // ₹90L
    monthlyRevenue: 3200000,     // ₹32L/mo
    monthlyFixedCosts: 500000,
    monthlyPayroll: 2100000,     // 25 consultants
    growthRate: 0.015,
    costGrowthRate: 0.028,       // demo assumption: consultant salary increments + office costs drift ~2.8%/mo, outpacing slow revenue growth
    paymentTermsDays: 45,        // typical B2B invoicing cycle
    avgMonthlySalary: 85000,
    customerConcentration: 0.42, // top client is ~42% of revenue — high concentration risk (see `customers` breakdown below)
    // FINANCIAL RISK RADAR — demo per-customer revenue breakdown (Feature: Customer
    // Concentration). This is illustrative/demo data, not a real transaction feed —
    // flagged via `customersAreDemoData` so the UI can label it appropriately.
    // Structured to be trivially replaceable with real transaction/settlement data
    // later (see README integration sketch) without touching any calculation code.
    customersAreDemoData: true,
    customers: [
      { name: 'Customer A', revenueShare: 0.42 },
      { name: 'Customer B', revenueShare: 0.25 },
      { name: 'Customer C', revenueShare: 0.18 },
      { name: 'Other customers', revenueShare: 0.15 },
    ],
  },
  saas_startup: {
    id: 'saas_startup',
    label: 'SaaS Startup (B2B Subscription)',
    description: 'Recurring-revenue SaaS, moderate cash reserves, aggressive hiring plans, VC-backed.',
    currency: '₹',
    startingCash: 15000000,      // ₹1.5Cr runway cushion
    monthlyRevenue: 2400000,     // ₹24L MRR
    monthlyFixedCosts: 800000,   // infra, tools, office
    monthlyPayroll: 3500000,     // 30 employees, higher salaries
    growthRate: 0.06,            // 6%/mo MRR growth target
    costGrowthRate: 0.035,       // demo assumption: aggressive hiring plan drives payroll growth ~3.5%/mo
    paymentTermsDays: 15,
    avgMonthlySalary: 116000,
    customerConcentration: 0.08, // diversified customer base
  },
};

function getProfile(id) {
  return PROFILES[id] || null;
}

function listProfiles() {
  return Object.values(PROFILES).map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    currency: p.currency,
    startingCash: p.startingCash,
    monthlyRevenue: p.monthlyRevenue,
    monthlyFixedCosts: p.monthlyFixedCosts,
    monthlyPayroll: p.monthlyPayroll,
    growthRate: p.growthRate,
    paymentTermsDays: p.paymentTermsDays,
  }));
}

module.exports = { PROFILES, getProfile, listProfiles };
