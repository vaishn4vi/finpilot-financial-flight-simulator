/**
 * personalAgent.js — Personal Mode's agentic layer
 * ---------------------------------------------------------
 * Same two-and-only-two responsibilities as agent.js:
 *   1. Turn free text into a structured intent + extracted numeric
 *      assumptions (income, savings, price, rent, EMI, goal amount...).
 *   2. Turn already-computed numbers into a short plain-language "why".
 * All arithmetic happens in personalEngine.js. This file never invents a
 * rupee figure — every number it extracts comes directly from the user's
 * own text, and every number it phrases comes from the engine's output.
 *
 * Reuses agent.js's LLM provider selection (LLM_PROVIDER env var) so
 * Personal Mode never needs its own provider/fallback plumbing.
 */

const agent = require('./agent');

// --- Indian-number parsing (₹18.4L, ₹1.5Cr, 70 lakh, 1.5 lakhs, etc.) -------
const NUM = '(-?[\\d,]+\\.?\\d*)\\s*(l|lakh|lakhs|cr|crore|crores|k|thousand|m)?\\b';

function parseIndianNumber(raw, suffix) {
  let n = parseFloat(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const s = (suffix || '').toLowerCase();
  if (s === 'l' || s === 'lakh' || s === 'lakhs') n *= 100000;
  else if (s === 'cr' || s === 'crore' || s === 'crores') n *= 10000000;
  else if (s === 'k' || s === 'thousand') n *= 1000;
  else if (s === 'm') n *= 1000000;
  return Math.round(n * 100) / 100;
}

// Handles spoken-out numbers from voice input, e.g. "one lakh fifty thousand"
// -> 150000, "seventy lakh" -> 7000000. Intentionally covers the common
// spoken patterns for this app's demo rather than being a full NLP number
// parser — falls through silently if it doesn't recognize the shape.
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function wordsToNumber(phrase) {
  const tokens = phrase.toLowerCase().trim().split(/\s+/);
  let total = 0;
  let current = 0;
  for (const tok of tokens) {
    if (tok === 'hundred') current *= 100;
    else if (WORD_NUMBERS[tok] != null) current += WORD_NUMBERS[tok];
    else if (tok === 'lakh' || tok === 'lakhs') { total += current * 100000; current = 0; }
    else if (tok === 'crore' || tok === 'crores') { total += current * 10000000; current = 0; }
    else if (tok === 'thousand') { total += current * 1000; current = 0; }
  }
  return total + current;
}

// Normalizes voice-style spelled-out amounts ("one lakh fifty thousand")
// into digit form ("150000") before the regex extractors below run, so
// voice input reuses the exact same extraction patterns as typed text.
// Only consumes number-words and unit-words themselves (never surrounding
// words like "have"/"earn") and only replaces runs that contain at least
// one unit word (lakh/crore/thousand) — bare number words are left alone.
const NUMBER_WORD_LIST = Object.keys(WORD_NUMBERS).concat(['hundred']).join('|');
const UNIT_WORD_LIST = 'lakh|lakhs|crore|crores|thousand';
const SPOKEN_RUN_RE = new RegExp(
  `\\b((?:${NUMBER_WORD_LIST}|${UNIT_WORD_LIST})(?:\\s+(?:${NUMBER_WORD_LIST}|${UNIT_WORD_LIST}))*)\\b`,
  'gi'
);

function normalizeSpokenNumbers(text) {
  return text.replace(SPOKEN_RUN_RE, (run) => {
    if (!new RegExp(`\\b(?:${UNIT_WORD_LIST})\\b`, 'i').test(run)) return run; // no unit word -> leave as-is
    const value = wordsToNumber(run);
    return value > 0 ? String(Math.round(value)) : run;
  });
}

// --- Field extraction --------------------------------------------------------
const NUM_NOT_PCT = `${NUM}(?!\\s*%)`; // never mistake "drops by 20%" for a rupee figure
const FIELD_PATTERNS = {
  monthlyIncome: [
    new RegExp(`(?:earn|income of|income is|salary|take.?home)${'[^\\d]{0,15}'}${NUM_NOT_PCT}`, 'i'),
  ],
  savings: [new RegExp(`(?:savings of|saved up|have)${'[^\\d]{0,15}'}${NUM_NOT_PCT}\\s*(?:in savings|savings|saved)?`, 'i')],
  price: [
    new RegExp(`(?:₹|rs\\.?|inr)?${NUM_NOT_PCT}\\s*(?:house|home|apartment|flat|property|car|vehicle)`, 'i'),
    new RegExp(`(?:house|home|apartment|flat|property|car|vehicle)\\s*(?:worth|costing|priced at|for)?${'[^\\d]{0,10}'}${NUM_NOT_PCT}`, 'i'),
  ],
  rent: [new RegExp(`(?:rent(?:ing)?)${'[^\\d]{0,15}'}${NUM_NOT_PCT}`, 'i')],
  emi: [new RegExp(`emi${'[^\\d]{0,15}'}${NUM_NOT_PCT}`, 'i')],
  goalAmount: [new RegExp(`(?:save|reach|goal of|target of)${'[^\\d]{0,15}'}${NUM_NOT_PCT}`, 'i')],
  years: [new RegExp(`(\\d+)\\s*years?`, 'i')],
  months: [new RegExp(`(\\d+)\\s*months?`, 'i')],
  pctChange: [new RegExp(`(\\d+)\\s*%`, 'i')],
};

function extractField(text, field) {
  for (const pattern of FIELD_PATTERNS[field]) {
    const m = text.match(pattern);
    if (m) {
      if (field === 'years' || field === 'months') return parseInt(m[1], 10);
      if (field === 'pctChange') return parseInt(m[1], 10) / 100;
      const value = parseIndianNumber(m[1], m[2]);
      if (value !== null) return value;
    }
  }
  return null;
}

function extractAssumptions(rawText) {
  const text = normalizeSpokenNumbers(rawText);
  const out = {};
  for (const field of Object.keys(FIELD_PATTERNS)) {
    const value = extractField(text, field);
    if (value !== null) out[field] = value;
  }
  return out;
}

// --- Intent classification ---------------------------------------------------
// Order matters: more specific intents are checked before generic ones.
function classifyIntent(rawText) {
  const t = rawText.toLowerCase();

  const mentionsIncomeDrop = /(income|salary|pay).{0,20}(drop|fall|cut|reduce|loss|lose my job)/.test(t);
  const mentionsHouse = /(house|home|apartment|flat|property)/.test(t);
  const mentionsCar = /\bcar\b|vehicle/.test(t);
  const mentionsRent = /\brent(ing)?\b/.test(t);
  const mentionsBuy = /\bbuy|purchase|afford\b/.test(t);
  const mentionsEmi = /\bemi\b/.test(t);
  const mentionsSafe = /(safe|maximum|max).{0,15}emi|emi.{0,15}(safe|maximum|max|afford)/.test(t);
  const mentionsGoal = /(save|reach|goal|how long|how much time)/.test(t);
  const mentionsRentalYield = /(rent(al)?\s*(yield|income)|charge.{0,10}rent|what rent)/.test(t);
  const mentionsEmergency = /emergency (fund|savings)/.test(t);
  const mentionsCompare = /\b(or|vs\.?|versus)\b/.test(t) && mentionsRent;
  const mentionsCompound = /\band\b/.test(t) && (mentionsIncomeDrop || mentionsHouse);

  const intents = [];

  if (mentionsSafe) intents.push({ type: 'safe_emi' });
  if (mentionsEmergency) intents.push({ type: 'emergency_fund' });
  if (mentionsRentalYield) intents.push({ type: 'rental_yield' });
  if (mentionsHouse && mentionsCompare) intents.push({ type: 'buy_vs_rent' });
  else if (mentionsHouse && mentionsBuy) intents.push({ type: 'afford_house' });
  if (mentionsCar && mentionsBuy && !intents.length) intents.push({ type: 'afford_purchase', assetLabel: 'car' });
  if (mentionsIncomeDrop) intents.push({ type: 'income_shock' });
  if (mentionsGoal && !mentionsHouse && !mentionsSafe && !mentionsRentalYield) intents.push({ type: 'goal' });

  if (!intents.length) intents.push({ type: 'unknown' });

  return { intents, isCompound: intents.length > 1 || mentionsCompound };
}

function parsePersonalQuestion(rawText) {
  const { intents, isCompound } = classifyIntent(rawText);
  const assumptions = extractAssumptions(rawText);
  return { intents, isCompound, assumptions, raw: rawText };
}

// --- Optional LLM assist (parse only — same non-negotiable rule as agent.js:
// the LLM never computes a number, it only helps read messy free text) ------
async function llmAssistedParse(rawText) {
  if (agent.getProvider() !== 'anthropic' || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const fetchFn = global.fetch || require('node-fetch');
    const system = `Extract structured personal-finance figures from a user's question. Respond with ONLY JSON: {"intentType": "afford_house"|"afford_purchase"|"buy_vs_rent"|"safe_emi"|"rental_yield"|"goal"|"income_shock"|"emergency_fund"|"unknown", "monthlyIncome": number|null, "savings": number|null, "price": number|null, "rent": number|null, "emi": number|null, "goalAmount": number|null, "years": number|null, "months": number|null, "pctChange": number|null}. Never compute an outcome — only extract numbers already present in the text.`;
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, system, messages: [{ role: 'user', content: rawText }] }),
    });
    const data = await res.json();
    const textBlock = (data.content || []).find((c) => c.type === 'text');
    if (!textBlock) return null;
    const parsed = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
    return parsed;
  } catch (err) {
    console.error('[personalAgent] LLM-assisted parse failed, using rule-based parser:', err.message);
    return null;
  }
}

async function parseQuestion(rawText) {
  const ruleBased = parsePersonalQuestion(rawText);
  const llm = await llmAssistedParse(rawText);
  if (!llm) return { ...ruleBased, providerUsed: 'rule-based' };

  // Merge: LLM fills gaps the regex extractor missed, but never overrides a
  // number the deterministic extractor already found from the raw text.
  const merged = { ...ruleBased.assumptions };
  const fieldMap = { monthlyIncome: 'monthlyIncome', savings: 'savings', price: 'price', rent: 'rent', emi: 'emi', goalAmount: 'goalAmount', years: 'years', months: 'months', pctChange: 'pctChange' };
  for (const [llmKey, localKey] of Object.entries(fieldMap)) {
    if (merged[localKey] == null && llm[llmKey] != null) merged[localKey] = llm[llmKey];
  }
  const intents = llm.intentType && llm.intentType !== 'unknown' ? [{ type: llm.intentType }] : ruleBased.intents;

  return { intents, isCompound: ruleBased.isCompound, assumptions: merged, raw: rawText, providerUsed: 'anthropic' };
}

module.exports = {
  parseIndianNumber,
  extractAssumptions,
  classifyIntent,
  parsePersonalQuestion,
  parseQuestion,
};
