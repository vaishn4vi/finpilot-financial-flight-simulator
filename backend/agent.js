/**
 * agent.js — The Agentic Layer
 * ---------------------------------------------------------
 * Responsibilities (and ONLY these):
 *   1. Parse a free-text "what if" question into a structured `intent`.
 *   2. Turn that intent into 2-3 branching scenario definitions, each a
 *      named strategy + a `shocks` array that engine.simulate() understands.
 *   3. After the engine has run the numbers, write a short plain-language
 *      recommendation by templating over the ALREADY-COMPUTED metrics.
 *
 * This file never invents a cash number. Every number quoted in the
 * final recommendation is read out of the engine's `summary` object.
 *
 * LLM provider selection: controlled by the LLM_PROVIDER env var.
 *   LLM_PROVIDER=anthropic  -> use the Anthropic API (requires ANTHROPIC_API_KEY)
 *   LLM_PROVIDER=ollama     -> use a local Ollama server (requires Ollama running
 *                              on localhost:11434 with OLLAMA_MODEL pulled)
 *   LLM_PROVIDER=none / unset -> skip LLM calls entirely, go straight to the
 *                              deterministic rule-based parser + templated
 *                              explanation (fastest path, zero network calls)
 *
 * Whichever provider is configured, step 1 (parsing) and step 3 (phrasing)
 * are the ONLY things ever delegated to it. If the configured provider
 * fails for any reason (not running, model not pulled, timeout, bad JSON),
 * the code catches the error and falls back to the rule-based path — a
 * broken LLM provider never crashes a request. The financial arithmetic
 * always happens exclusively in engine.js, regardless of provider.
 */

const fmtMoney = (n, currency = '₹') =>
  `${currency}${Math.round(n).toLocaleString('en-IN')}`;

function getFetch() {
  return global.fetch || require('node-fetch');
}

function getProvider() {
  const p = (process.env.LLM_PROVIDER || 'none').toLowerCase();
  return ['anthropic', 'ollama'].includes(p) ? p : 'none';
}

// Small helper: race a promise against a timeout so a hung local model
// (or an unreachable host) can never leave a request hanging indefinitely.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const INTENT_SCHEMA_NOTE = `A single intent object looks like:
{"type": "hire" | "delay_payment" | "revenue_drop" | "revenue_growth" | "lose_customer" | "cost_change" | "payroll_change" | "unknown", "count": number|null, "days": number|null, "pct": number|null}
For "cost_change" and "payroll_change", pct is SIGNED: positive = increase, negative = decrease.
pct should be a fraction (20% -> 0.2). If a field doesn't apply, use null. Never compute financial outcomes yourself — only extract structured parameters.

If the question describes MULTIPLE distinct scenarios joined by words like "and", "plus", or "also" (e.g. "what if I hire 10 people AND my biggest customer pays 30 days late"), respond with a JSON ARRAY of intent objects instead of a single object — one entry per distinct shock described. If there is only one shock, respond with a single object (not a one-element array).`;

// Phrases that signal the user is asking a BOUNDARY question ("what's the
// most I can do safely") rather than describing a fixed scenario. These
// route to the breakeven/safe-threshold engine instead of fixed branching.
function detectBreakevenIntent(text) {
  const t = text.toLowerCase();
  const isBoundaryPhrase =
    /how many.{0,20}(can i|could i).{0,15}(afford|hire)/.test(t) ||
    /how much.{0,20}(can i|could i).{0,15}(afford|survive|handle|absorb)/.test(t) ||
    /what.{0,4}s the (most|max|maximum|least|minimum)/.test(t) ||
    /what is the (most|max|maximum|least|minimum)/.test(t) ||
    /(most|maximum) (i can|number of|employees|people|hires)/.test(t) ||
    /safely (hire|afford)/.test(t) ||
    /how (many|much) .{0,25}(survive|afford)/.test(t);

  if (!isBoundaryPhrase) return null;

  const mentionsHiring = /(hire|employee|people|staff|headcount)/.test(t);
  const mentionsRevenue = /(revenue|sales|customer|income|drop|decline|fall)/.test(t);

  let shockType = null;
  if (mentionsHiring && !mentionsRevenue) shockType = 'hire';
  else if (mentionsRevenue && !mentionsHiring) shockType = 'revenue_shock';
  else if (mentionsHiring) shockType = 'hire'; // ambiguous mention of both -> default to hiring boundary

  if (!shockType) return null;

  // Optional: "...without runway dropping below 6 months"
  const monthsMatch = t.match(/(\d+)\s*months?/);
  const targetMinRunwayMonths = monthsMatch ? parseInt(monthsMatch[1], 10) : undefined;

  return { isBreakeven: true, shockType, targetMinRunwayMonths, raw: text };
}

// ---------------------------------------------------------------------------
// STEP 1: Parse free text into a structured intent (rule-based fallback)
// ---------------------------------------------------------------------------
function ruleBasedParse(text) {
  const t = text.toLowerCase();

  // Hiring intent: "hire 10 employees", "hire 5 people", "add 3 engineers"
  let m = t.match(/(?:hire|add|onboard)\s+(\d+)\s*(?:new\s+)?(?:employees?|people|staff|engineers?|hires?)/);
  if (m) {
    return { type: 'hire', count: parseInt(m[1], 10), raw: text };
  }

  // Early payment intent: "customer pays 15 days early", "pays 10 days sooner"
  // — checked BEFORE the late-payment pattern below since both share the
  // "N days" shape and differ only in the direction word.
  m = t.match(/(\d+)\s*days?\s*(early|earlier|ahead|sooner)/) || t.match(/(early|earlier|ahead of schedule|sooner).{0,15}?(\d+)\s*days?/);
  if (m) {
    const days = parseInt((m[0].match(/\d+/) || ['15'])[0], 10);
    return { type: 'early_payment', days, raw: text };
  }

  // Late payment intent: "customer pays 15 days late", "delayed by 30 days"
  m = t.match(/(\d+)\s*days?\s*(late|delay|delayed)/) || t.match(/(late|delay|delayed).{0,15}?(\d+)\s*days?/);
  if (m) {
    const days = parseInt(m[1].match(/\d+/) ? m[1] : m[2], 10) || parseInt((m[0].match(/\d+/) || ['30'])[0], 10);
    return { type: 'delay_payment', days: days, raw: text };
  }

  // Revenue drop intent: "revenue drops 20%", "sales fall by 15 percent", "lose a big customer"
  m = t.match(/(?:revenue|sales|income).{0,15}?(?:drop|fall|decline|decrease).{0,10}?(\d+)\s*%?/) ||
      t.match(/(\d+)\s*%.{0,15}?(?:drop|fall|decline|decrease)/);
  if (m) {
    return { type: 'revenue_drop', pct: parseInt(m[1], 10) / 100, raw: text };
  }
  if (/lose.{0,20}(customer|client)/.test(t)) {
    return { type: 'lose_customer', raw: text };
  }

  // Revenue growth / price increase intent
  m = t.match(/(?:revenue|sales|prices?).{0,20}?(?:grows?|increases?|rises?|up)\b.{0,10}?(\d+)\s*%?/);
  if (m) {
    return { type: 'revenue_growth', pct: parseInt(m[1], 10) / 100, raw: text };
  }

  // Fixed-cost change intent: "fixed costs increase 10%", "costs go up 8%",
  // "expenses decrease 15%", "cut costs by 10%" — reuses the same
  // `costCutPct` lever already wired into materializeCostAdjustments()
  // (positive = cut, negative = increase), so no new shock type is needed.
  const COST_WORD = '(?:fixed costs?|operating costs?|costs?|expenses?|opex)';
  m = t.match(new RegExp(`${COST_WORD}.{0,20}?(?:increases?|rises?|rise|grows?|goes? up|going up)\\b.{0,10}?(\\d+)\\s*%?`)) ||
      t.match(new RegExp(`(?:increase|increases|raise|raises)\\b.{0,20}?${COST_WORD}.{0,10}?(\\d+)\\s*%?`));
  if (m) {
    return { type: 'cost_change', pct: parseInt(m[1], 10) / 100, raw: text }; // positive pct = increase
  }
  m = t.match(new RegExp(`${COST_WORD}.{0,20}?(?:decreases?|drops?|falls?|cuts?|reduces?)\\b.{0,10}?(\\d+)\\s*%?`)) ||
      t.match(new RegExp(`(?:decrease|decreases|drop|drops|fall|falls|cut|cuts|reduce|reduces)\\b.{0,20}?${COST_WORD}.{0,10}?(\\d+)\\s*%?`));
  if (m) {
    return { type: 'cost_change', pct: -(parseInt(m[1], 10) / 100), raw: text }; // negative pct = decrease
  }

  // Payroll change intent: "reduce payroll 10%", "freeze hiring and reduce
  // payroll 10%", "payroll increases 8%" — reuses `payrollCutPct`. Checked
  // in both word orders ("payroll decreases 10%" and "decrease payroll 10%").
  m = t.match(/payroll.{0,20}?(?:decreases?|drops?|falls?|cuts?|reduces?)\b.{0,10}?(\d+)\s*%?/) ||
      t.match(/(?:decrease|decreases|drop|drops|fall|falls|cut|cuts|reduce|reduces)\b.{0,20}?payroll.{0,10}?(\d+)\s*%?/);
  if (m) {
    return { type: 'payroll_change', pct: -(parseInt(m[1], 10) / 100), raw: text };
  }
  m = t.match(/payroll.{0,20}?(?:increases?|rises?|grows?)\b.{0,10}?(\d+)\s*%?/) ||
      t.match(/(?:increase|increases|raise|raises)\b.{0,20}?payroll.{0,10}?(\d+)\s*%?/);
  if (m) {
    return { type: 'payroll_change', pct: parseInt(m[1], 10) / 100, raw: text };
  }

  // Fallback: unrecognized — still return something usable
  return { type: 'unknown', raw: text };
}

// FEATURE 3 — Compound scenario detection (rule-based). Splits on "and" /
// "plus" / "also" and parses each segment independently. Only returns a
// compound array if at least 2 segments produce a *recognized* (non-'unknown')
// intent — otherwise falls back to treating the whole text as one segment,
// so a sentence that merely contains the word "and" incidentally
// ("what if I hire employees and grow the team") doesn't get needlessly
// split into a bogus multi-intent.
function ruleBasedParseCompound(text) {
  const segments = text
    .split(/\s+(?:and|plus|also)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    return [ruleBasedParse(text)];
  }

  const parsedSegments = segments.map((seg) => ruleBasedParse(seg));
  const recognized = parsedSegments.filter((p) => p.type !== 'unknown');

  if (recognized.length >= 2) {
    return recognized;
  }

  // Splitting didn't yield ≥2 recognizable shocks — treat as a single intent
  // over the full original text instead (avoids false-positive splitting).
  return [ruleBasedParse(text)];
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------
async function anthropicParse(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const systemPrompt = `You convert a small-business "what if" financial question into strict JSON describing the scenario intent(s). Respond with ONLY JSON, no prose, no markdown fences, matching this schema:
${INTENT_SCHEMA_NOTE}`;

  const fetchFn = getFetch();
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    }),
  });
  const data = await res.json();
  const textBlock = (data.content || []).find((c) => c.type === 'text');
  if (!textBlock) throw new Error('Anthropic response had no text block');
  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (Array.isArray(parsed)) {
    parsed.forEach((p) => { p.raw = text; });
  } else {
    parsed.raw = text;
  }
  return parsed;
}

async function anthropicExplanation(recommended, allScenarios, profile) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const summaryPayload = allScenarios.map((s) => ({ name: s.name, summary: s.result.summary }));
  const prompt = `Business: ${profile.label}. Here are computed (already-correct, do not alter any numbers) scenario summaries in JSON: ${JSON.stringify(summaryPayload)}. The recommended scenario is "${recommended.name}". In 2-3 short plain-language sentences for a non-finance founder, explain why this path is the safest, referencing the actual numbers given (currency ${profile.currency}). Do not invent numbers not present in the JSON.`;

  const fetchFn = getFetch();
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  const textBlock = (data.content || []).find((c) => c.type === 'text');
  if (!textBlock) throw new Error('Anthropic response had no text block');
  return textBlock.text.trim();
}

// ---------------------------------------------------------------------------
// Ollama provider (local, private — see README "Running with local Ollama")
// ---------------------------------------------------------------------------
function ollamaModel() {
  return process.env.OLLAMA_MODEL || 'llama3.1:8b';
}

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_TIMEOUT_MS = 20000;

async function ollamaParse(text, profile) {
  const prompt = `You convert a small-business "what if" financial question into strict JSON describing the scenario intent(s). Respond with ONLY JSON, no prose, no markdown fences, matching this schema:
${INTENT_SCHEMA_NOTE}

Question: "${text}"`;

  const fetchFn = getFetch();
  const call = fetchFn(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel(),
      prompt,
      format: 'json', // forces Ollama to constrain output to valid JSON
      stream: false,
    }),
  });

  const res = await withTimeout(call, OLLAMA_TIMEOUT_MS, `Ollama parse (${ollamaModel()})`);
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data.response) throw new Error('Ollama response had no `response` field');
  const parsed = JSON.parse(data.response);
  if (Array.isArray(parsed)) {
    parsed.forEach((p) => { p.raw = text; });
  } else {
    parsed.raw = text;
  }
  return parsed;
}

async function ollamaExplanation(recommended, allScenarios, profile) {
  const summaryPayload = allScenarios.map((s) => ({ name: s.name, summary: s.result.summary }));
  const prompt = `Business: ${profile.label}. Here are computed (already-correct, do not alter any numbers) scenario summaries in JSON: ${JSON.stringify(summaryPayload)}. The recommended scenario is "${recommended.name}". In 2-3 short plain-language sentences for a non-finance founder, explain why this path is the safest, referencing the actual numbers given (currency ${profile.currency}). Do not invent numbers not present in the JSON. Respond with plain text only, no markdown.`;

  const fetchFn = getFetch();
  const call = fetchFn(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel(),
      prompt,
      stream: false,
    }),
  });

  const res = await withTimeout(call, OLLAMA_TIMEOUT_MS, `Ollama explanation (${ollamaModel()})`);
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data.response) throw new Error('Ollama response had no `response` field');
  return data.response.trim();
}

// ---------------------------------------------------------------------------
// Provider dispatch — tries the configured provider, always falls back to
// rule-based on any failure, and reports which one actually produced the
// result so the UI can be honest about it.
//
// Returns { intents: Intent[], providerUsed } — ALWAYS an array, even for a
// single-shock question (array of length 1). This keeps buildScenarios()
// (and everything downstream) working with one consistent shape whether the
// question was simple or compound (FEATURE 3).
// ---------------------------------------------------------------------------
function normalizeParsedResult(result) {
  const list = Array.isArray(result) ? result : [result];
  const valid = list.filter((r) => r && r.type && r.type !== 'unknown');
  return valid;
}

async function parseIntent(text, profile) {
  const provider = getProvider();

  if (provider === 'anthropic') {
    try {
      const result = await anthropicParse(text);
      const intents = normalizeParsedResult(result);
      if (intents.length >= 1) return { intents, providerUsed: 'anthropic' };
    } catch (err) {
      console.error('[agent] Anthropic parse failed, falling back to rule-based parser:', err.message);
    }
  }

  if (provider === 'ollama') {
    try {
      const result = await ollamaParse(text, profile);
      const intents = normalizeParsedResult(result);
      if (intents.length >= 1) return { intents, providerUsed: 'ollama' };
    } catch (err) {
      console.error('[agent] Ollama parse failed, falling back to rule-based parser:', err.message);
    }
  }

  const ruleBasedIntents = ruleBasedParseCompound(text);
  return { intents: ruleBasedIntents, providerUsed: 'rule-based' };
}

// ---------------------------------------------------------------------------
// STEP 2: Turn an intent into 2-3 branching scenario definitions
// ---------------------------------------------------------------------------
function buildSingleIntentScenarios(intent, profile) {
  const salary = profile.avgMonthlySalary || 60000;

  switch (intent.type) {
    case 'hire': {
      const n = intent.count || 5;
      const third = Math.ceil(n / 3);
      const remainder = n - 2 * third > 0 ? n - 2 * third : 0;
      return [
        {
          name: 'Hire all at once',
          description: `Bring on all ${n} hires starting next month.`,
          shocks: [{ type: 'hire', month: 1, count: n, avgMonthlySalary: salary }],
        },
        {
          name: 'Phased hiring (3 months)',
          description: `Spread the ${n} hires across 3 months to ease cash pressure.`,
          shocks: [
            { type: 'hire', month: 1, count: third, avgMonthlySalary: salary },
            { type: 'hire', month: 2, count: third, avgMonthlySalary: salary },
            { type: 'hire', month: 3, count: Math.max(remainder, n - 2 * third), avgMonthlySalary: salary },
          ],
        },
        {
          name: 'Delay hiring by 3 months',
          description: `Wait until month 4 to bring on all ${n} hires, after revenue has grown further.`,
          shocks: [{ type: 'hire', month: 4, count: n, avgMonthlySalary: salary }],
        },
      ];
    }

    case 'delay_payment': {
      const days = intent.days || 30;
      const delayMonths = Math.max(1, Math.round(days / 30));
      const share = profile.customerConcentration || 0.2;
      const amount = profile.monthlyRevenue * share;
      return [
        {
          name: 'Absorb the delay (no action)',
          description: `Customer worth ~${fmtMoney(amount, profile.currency)}/mo pays ${days} days late; you simply wait it out.`,
          shocks: [{ type: 'delay_payment', fromMonth: 2, amount, delayMonths }],
        },
        {
          name: 'Negotiate 50% upfront',
          description: `Negotiate half the invoice paid on time, half delayed ${days} days.`,
          shocks: [{ type: 'delay_payment', fromMonth: 2, amount: amount * 0.5, delayMonths }],
        },
        {
          name: 'Bridge with short-term credit',
          description: `Draw a short-term credit line to cover the gap, repaid with interest once the customer pays (e.g. via Razorpay Capital).`,
          shocks: [
            { type: 'delay_payment', fromMonth: 2, amount, delayMonths },
            { type: 'one_time_cash', month: 2, amount: amount * 0.9 }, // credit draw covers 90% of the gap
            { type: 'one_time_cash', month: 2 + delayMonths, amount: -(amount * 0.9 * 1.02) }, // repay + 2% interest
          ],
        },
      ];
    }

    case 'early_payment': {
      // Mirror image of 'delay_payment': a customer paying EARLY pulls
      // revenue forward instead of pushing it back. Modeled the same way
      // sensitivityAnalysis()'s paymentTermsDays perturbation already models
      // "customers pay faster" (engine.js, direction=-1 branch): a one-time
      // cash inflow equal to the accelerated slice of monthly revenue.
      const days = intent.days || 15;
      const share = profile.customerConcentration || 0.2;
      const sliceFraction = Math.min(days / 30, 1);
      const amount = profile.monthlyRevenue * share * sliceFraction;
      return [
        {
          name: 'Full early payment',
          description: `Customer worth ~${fmtMoney(profile.monthlyRevenue * share, profile.currency)}/mo pays ${days} days early, pulling that cash forward one month.`,
          shocks: [{ type: 'one_time_cash', month: 2, amount }],
        },
        {
          name: 'Partial early payment (50%)',
          description: `Negotiate half the invoice paid ${days} days early, the rest on normal terms.`,
          shocks: [{ type: 'one_time_cash', month: 2, amount: amount * 0.5 }],
        },
      ];
    }

    case 'lose_customer':
    case 'revenue_drop': {
      const pct = intent.pct || (intent.type === 'lose_customer' ? (profile.customerConcentration || 0.2) : 0.2);
      return [
        {
          name: 'No mitigation',
          description: `Revenue drops ${(pct * 100).toFixed(0)}% starting next month; costs stay the same.`,
          shocks: [{ type: 'revenue_shock', startMonth: 2, pctChange: -pct }],
        },
        {
          name: 'Cut costs 10%',
          description: `Offset part of the drop by trimming fixed costs 10% from month 2.`,
          shocks: [
            { type: 'revenue_shock', startMonth: 2, pctChange: -pct },
            { type: 'revenue_shock', startMonth: 2, pctChange: 0 }, // placeholder, cost cut handled below via hire-negative trick
          ],
          costCutPct: 0.10,
        },
        {
          name: 'Freeze hiring & non-essential spend',
          description: `Freeze all new hiring and cut discretionary spend 15% to preserve runway.`,
          shocks: [{ type: 'revenue_shock', startMonth: 2, pctChange: -pct }],
          costCutPct: 0.15,
        },
      ];
    }

    case 'revenue_growth': {
      const pct = intent.pct || 0.1;
      return [
        {
          name: 'Conservative execution',
          description: `Achieve half of the targeted ${(pct * 100).toFixed(0)}% revenue boost.`,
          shocks: [{ type: 'revenue_shock', startMonth: 2, pctChange: pct * 0.5 }],
        },
        {
          name: 'On-target execution',
          description: `Hit the full ${(pct * 100).toFixed(0)}% revenue boost from month 2.`,
          shocks: [{ type: 'revenue_shock', startMonth: 2, pctChange: pct }],
        },
        {
          name: 'Growth requires extra headcount',
          description: `Hit the target, but need 2 extra hires from month 2 to support it.`,
          shocks: [
            { type: 'revenue_shock', startMonth: 2, pctChange: pct },
            { type: 'hire', month: 2, count: 2, avgMonthlySalary: salary },
          ],
        },
      ];
    }

    case 'cost_change': {
      const pct = typeof intent.pct === 'number' ? intent.pct : 0.10;
      const cutPct = -pct; // costCutPct convention: positive = cut costs, negative = increase
      const verb = pct >= 0 ? 'increase' : 'decrease';
      return [
        {
          name: `Absorb the cost ${verb}`,
          description: `Fixed costs ${verb} ${Math.abs(pct * 100).toFixed(0)}% starting next month; no other changes.`,
          shocks: [],
          costCutPct: cutPct,
        },
        {
          name: 'Offset with a price increase',
          description: `Offset part of the cost ${verb} with a matching price increase from month 2.`,
          shocks: [{ type: 'revenue_shock', startMonth: 2, pctChange: Math.max(pct, 0) }],
          costCutPct: cutPct,
        },
      ];
    }

    case 'payroll_change': {
      const pct = typeof intent.pct === 'number' ? intent.pct : -0.10;
      const verb = pct >= 0 ? 'increase' : 'decrease';
      return [
        {
          name: `Absorb the payroll ${verb}`,
          description: `Payroll cost ${verb}s ${Math.abs(pct * 100).toFixed(0)}% starting next month.`,
          shocks: [],
          payrollCutPct: -pct,
        },
        {
          name: 'Freeze hiring & phase it in over 3 months',
          description: `Phase the payroll ${verb} in gradually over 3 months while freezing all new hiring.`,
          shocks: [{ type: 'hire', month: 1, count: 0, avgMonthlySalary: 0 }],
          payrollCutPct: -pct,
        },
      ];
    }

    default: {
      // Unknown / unparseable intent: still produce something useful.
      return [
        {
          name: 'Current trajectory (baseline)',
          description: `No specific shock detected in your question — showing your current trajectory as-is.`,
          shocks: [],
        },
        {
          name: 'Conservative buffer (+10% costs)',
          description: `A general risk buffer in case of unexpected cost overruns.`,
          shocks: [{ type: 'hire', month: 1, count: 0, avgMonthlySalary: 0 }],
          costCutPct: -0.10, // negative = cost increase, reuse the same lever
        },
      ];
    }
  }
}

// Some scenarios use convenience fields instead of raw shocks:
//   costCutPct    (positive = cut FIXED costs, negative = increase them)
//   payrollCutPct (positive = cut PAYROLL cost, negative = increase it — e.g.
//                  "reduce hiring plans" modeled as a payroll reduction from
//                  month 2 onward)
// Materialize them here as actual one_time_cash shocks so engine.js only
// ever sees the standard shock vocabulary it already understands.
function materializeCostAdjustments(scenario, profile) {
  const extraShocks = [];

  if (scenario.costCutPct) {
    const monthlySaving = profile.monthlyFixedCosts * scenario.costCutPct;
    for (let m = 2; m <= 12; m++) {
      extraShocks.push({ type: 'one_time_cash', month: m, amount: monthlySaving });
    }
  }

  if (scenario.payrollCutPct) {
    const monthlySaving = profile.monthlyPayroll * scenario.payrollCutPct;
    for (let m = 2; m <= 12; m++) {
      extraShocks.push({ type: 'one_time_cash', month: m, amount: monthlySaving });
    }
  }

  if (!extraShocks.length) return scenario.shocks;
  return [...scenario.shocks, ...extraShocks];
}

// ---------------------------------------------------------------------------
// "WHAT SHOULD I DO?" DECISION MODE
// ---------------------------------------------------------------------------
// Unlike buildScenarios() (which branches off a parsed "what if" shock),
// this generates a fixed family of financially meaningful turnaround
// levers for the business AS IT CURRENTLY STANDS (profile + any live slider
// overrides already applied by the caller). No LLM/NLP parsing is needed —
// the input is the business's own numbers, not free text — so this is 100%
// deterministic end to end. Every lever is expressed with the exact same
// shock vocabulary engine.simulate() already understands, so it plugs into
// the identical simulate -> rank -> explain pipeline as buildScenarios().
function buildDecisionStrategies(profile) {
  return [
    {
      name: 'Hold current course',
      description: 'No changes — continue at current revenue, costs, and payroll.',
      shocks: [],
    },
    {
      name: 'Cut operating costs 15%',
      description: 'Trim fixed costs (rent, tools, discretionary spend) by 15% starting next month.',
      shocks: [],
      costCutPct: 0.15,
    },
    {
      name: 'Freeze hiring & reduce payroll 10%',
      description: 'Freeze all new hiring and reduce payroll cost 10% (attrition, restructuring, or delayed backfills) starting next month.',
      shocks: [],
      payrollCutPct: 0.10,
    },
    {
      name: 'Increase pricing 10%',
      description: 'Raise prices 10%, phased in from month 2, with no cost changes.',
      shocks: [{ type: 'revenue_shock', startMonth: 2, pctChange: 0.10 }],
    },
    {
      name: 'Invest in sales (higher spend, faster growth)',
      description: 'Increase sales & marketing spend 8% to accelerate growth by an extra ~3%/mo from month 3.',
      shocks: [{ type: 'revenue_shock', startMonth: 3, pctChange: 0.03 }],
      costCutPct: -0.08,
    },
    {
      name: 'Combination: cut costs 10% + raise prices 5%',
      description: 'Trim fixed costs 10% and raise prices 5% at the same time — a balanced, lower-risk lever.',
      shocks: [{ type: 'revenue_shock', startMonth: 2, pctChange: 0.05 }],
      costCutPct: 0.10,
    },
  ];
}

// ---------------------------------------------------------------------------
// FINANCIAL RISK RADAR — "Protect My Business" action builder
// ---------------------------------------------------------------------------
// Maps DETECTED risks (from engine.analyzeRisks(), already scored/severity-
// classified) to a small set of candidate protective actions, expressed with
// the exact same shock vocabulary (`shocks[]`, `costCutPct`, `payrollCutPct`)
// used everywhere else in this file. This function only DECIDES WHICH
// actions are relevant and how to phrase them — it never computes a
// financial outcome itself. server.js runs each candidate through
// engine.simulate() (the one and only place cash math happens) and reports
// the delta versus the baseline, exactly like buildDecisionStrategies().
const PROTECTIVE_ACTION_LIBRARY = {
  customerConcentration: {
    name: 'Improve collections from top customer',
    description: 'Tighten payment terms with your largest customer to pull forward roughly two weeks of their revenue.',
    simulateQuestion: 'What if my biggest customer pays 15 days early?',
    build: (profile) => ({
      shocks: [{ type: 'one_time_cash', month: 2, amount: (profile.monthlyRevenue || 0) * (getLargestCustomerShare(profile)) * 0.5 }],
    }),
  },
  paymentCycle: {
    name: 'Improve collections by 15 days',
    description: 'Negotiate faster payment terms across customers, pulling forward roughly half a month of receivables.',
    simulateQuestion: 'What if my biggest customer pays 15 days early?',
    build: (profile) => ({
      shocks: [{ type: 'one_time_cash', month: 2, amount: (profile.monthlyRevenue || 0) * 0.5 }],
    }),
  },
  cashBuffer: {
    name: 'Delay discretionary spending by 2 months',
    description: 'Pause non-essential fixed-cost spend (tools, discretionary ops) for 2 months to rebuild the cash buffer.',
    simulateQuestion: 'What if fixed costs decrease by 15%?',
    build: (profile) => {
      const saving = (profile.monthlyFixedCosts || 0) * 0.15;
      return { shocks: [
        { type: 'one_time_cash', month: 1, amount: saving },
        { type: 'one_time_cash', month: 2, amount: saving },
      ] };
    },
  },
  burnCost: {
    name: 'Freeze hiring & reduce payroll 10%',
    description: 'Freeze new hiring and trim payroll cost 10% starting next month to bring cost growth back under revenue growth.',
    simulateQuestion: 'What if I freeze hiring and reduce payroll 10%?',
    build: () => ({ shocks: [], payrollCutPct: 0.10 }),
  },
  revenueGrowth: {
    name: 'Increase pricing 10%',
    description: 'Raise prices 10%, phased in from month 2, to restore a growth rate that outpaces costs.',
    simulateQuestion: 'What if revenue grows 10%?',
    build: () => ({ shocks: [{ type: 'revenue_shock', startMonth: 2, pctChange: 0.10 }] }),
  },
};

function getLargestCustomerShare(profile) {
  if (Array.isArray(profile.customers) && profile.customers.length) {
    return Math.max(...profile.customers.map((c) => c.revenueShare));
  }
  return profile.customerConcentration || 0.2;
}

// Returns up to 3 candidate protective-action DEFINITIONS (name, description,
// shocks/costCutPct/payrollCutPct) for the risks currently at medium/high
// severity, most severe first. server.js is responsible for simulating each
// one and attaching the computed impact.
function buildProtectiveActions(profile, risks) {
  const relevant = risks
    .filter((r) => r.available !== false && (r.severity === 'high' || r.severity === 'medium'))
    .sort((a, b) => (b.deductionPoints || 0) - (a.deductionPoints || 0));

  const actions = [];
  const usedKeys = new Set();
  for (const risk of relevant) {
    const template = PROTECTIVE_ACTION_LIBRARY[risk.key];
    if (!template || usedKeys.has(risk.key)) continue;
    usedKeys.add(risk.key);
    const built = template.build(profile);
    actions.push({
      forRisk: risk.key,
      name: template.name,
      description: template.description,
      simulateQuestion: template.simulateQuestion,
      shocks: built.shocks || [],
      costCutPct: built.costCutPct,
      payrollCutPct: built.payrollCutPct,
    });
    if (actions.length >= 3) break;
  }

  // No medium/high risks at all — the business is healthy; still give one
  // constructive, low-effort suggestion rather than an empty section.
  if (!actions.length) {
    actions.push({
      forRisk: null,
      name: 'Increase cash reserve',
      description: 'No urgent risks detected. Consider building additional cash reserve as a buffer against future shocks.',
      simulateQuestion: 'What if fixed costs decrease by 5%?',
      shocks: [],
      costCutPct: 0.05,
    });
  }

  return actions;
}

// FEATURE 3 — Compound / stacked scenarios. Given 2+ intents parsed from one
// question, build each intent's own strategy family independently (using the
// same logic as a single intent), then merge them pairwise by "aggressiveness
// rank" — e.g. the phased/moderate hiring strategy merges with the
// negotiated/moderate payment-delay strategy — into 2-3 COMBINED scenario
// definitions. This proves the agent is reasoning over multiple simultaneous
// shocks together, not just running each shock through a separate template.
function mergeIntentScenarios(perIntentScenarios) {
  const slotCount = Math.max(...perIntentScenarios.map((s) => s.length));
  const merged = [];

  for (let slot = 0; slot < slotCount; slot++) {
    const components = perIntentScenarios.map((scenarios) => scenarios[slot % scenarios.length]);

    const name = components.map((c) => c.name).join(' + ');
    const description = `Combined scenario: ${components.map((c) => c.description).join(' ')}`;
    const shocks = components.flatMap((c) => c.shocks);
    const costCutPct = components.reduce((sum, c) => sum + (c.costCutPct || 0), 0) || undefined;

    merged.push({ name, description, shocks, costCutPct, isCompound: true });
  }

  // De-duplicate identically-named merges (can happen with small slot counts).
  const seen = new Set();
  return merged.filter((m) => {
    if (seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });
}

// Public entry point. Accepts either a single intent object OR an array of
// intents (from a compound "and"/"plus"/"also" question). Always returns a
// flat array of 2-3 scenario definitions, exactly like before for the
// single-intent case — so this is a drop-in replacement for the old
// buildScenarios(intent, profile) signature.
function buildScenarios(intentOrIntents, profile) {
  const intents = Array.isArray(intentOrIntents) ? intentOrIntents : [intentOrIntents];

  if (intents.length <= 1) {
    return buildSingleIntentScenarios(intents[0], profile);
  }

  const perIntentScenarios = intents.map((intent) => buildSingleIntentScenarios(intent, profile));
  return mergeIntentScenarios(perIntentScenarios);
}

// ---------------------------------------------------------------------------
// STEP 3: Recommend the safest path + plain-language explanation
// ---------------------------------------------------------------------------
function pickRecommendation(scenarioResults) {
  // Rank by: fewest critical (negative-cash) months, then highest minCash.
  const sorted = [...scenarioResults].sort((a, b) => {
    if (a.result.summary.criticalMonthCount !== b.result.summary.criticalMonthCount) {
      return a.result.summary.criticalMonthCount - b.result.summary.criticalMonthCount;
    }
    if (a.result.summary.minCash !== b.result.summary.minCash) {
      return b.result.summary.minCash - a.result.summary.minCash;
    }
    return b.result.summary.endCash - a.result.summary.endCash;
  });
  return sorted[0];
}

function ruleBasedExplanation(recommended, allScenarios, profile) {
  const s = recommended.result.summary;
  const currency = profile.currency || '₹';
  const others = allScenarios.filter((sc) => sc.name !== recommended.name);

  let riskLine;
  if (s.goesNegative) {
    riskLine = `Even on this path, cash turns negative in month ${s.monthOfInsolvency} — you'll need financing or cost cuts before then.`;
  } else if (s.criticalMonthCount > 0) {
    riskLine = `Cash stays positive throughout, but runs thin (under 2 months of buffer) in ${s.criticalMonthCount} month(s).`;
  } else {
    riskLine = `Cash stays healthy across the full 12-month horizon.`;
  }

  const comparisonLine = others.length
    ? ` Compared to "${others[0].name}" (lowest point ${fmtMoney(others[0].result.summary.minCash, currency)}), this path keeps the lowest cash point at ${fmtMoney(s.minCash, currency)} in month ${s.minCashMonth}.`
    : '';

  return `Recommended path: "${recommended.name}". ${riskLine}${comparisonLine} Projected cash at month 12: ${fmtMoney(s.endCash, currency)}.`;
}

async function getExplanation(recommended, allScenarios, profile) {
  const provider = getProvider();

  if (provider === 'anthropic') {
    try {
      const text = await anthropicExplanation(recommended, allScenarios, profile);
      if (text) return { explanation: text, providerUsed: 'anthropic' };
    } catch (err) {
      console.error('[agent] Anthropic explanation failed, falling back to template:', err.message);
    }
  }

  if (provider === 'ollama') {
    try {
      const text = await ollamaExplanation(recommended, allScenarios, profile);
      if (text) return { explanation: text, providerUsed: 'ollama' };
    } catch (err) {
      console.error('[agent] Ollama explanation failed, falling back to template:', err.message);
    }
  }

  return { explanation: ruleBasedExplanation(recommended, allScenarios, profile), providerUsed: 'rule-based' };
}

module.exports = {
  getProvider,
  ollamaModel,
  parseIntent,
  detectBreakevenIntent,
  buildScenarios,
  buildDecisionStrategies,
  buildProtectiveActions,
  materializeCostAdjustments,
  pickRecommendation,
  getExplanation,
  fmtMoney,
};
