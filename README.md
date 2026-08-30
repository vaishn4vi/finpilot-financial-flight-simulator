# FinPilot — AI Financial Controller
*(formerly "Financial Flight Simulator")*

**Track:** AI Finance Controller 
**🔗 Live demo:** https://finpilot-financial-flight-simulator-1.onrender.com

Ask a plain-English financial question — *"I have ₹40L cash, revenue is
growing 5%/mo, my biggest customer may pay 30 days late, and I want to hire
10 engineers — can I afford it?"* — and the system extracts the assumptions,
branches them into concrete strategies, runs each through a real 12-month
cash-flow model, evaluates risk and sensitivity, finds the safe boundary,
and recommends the best path in plain language, with every number traceable
back to deterministic code.

---

## Architecture assessment (before vs. after this pass)

**What was already strong and was preserved as-is:**
- `engine.js` — pure, deterministic month-by-month cash simulation. Zero
  LLM calls. `simulate()`, `sensitivityAnalysis()`, `findSafeThreshold()`
  were correct and are now covered by 16 unit tests (see `backend/tests/`).
- `agent.js`'s 3-tier LLM fallback (Anthropic → Ollama → rule-based parser),
  compound "and/plus/also" intent splitting, and boundary-question detection
  — all solid, reused without modification.
- The branching-strategy pattern (`buildScenarios` → `pickRecommendation` →
  `getExplanation`) — this is the right shape for "LLM interprets/explains,
  engine calculates," so new features (decision mode) reuse it rather than
  inventing a parallel pipeline.

**What was weak or missing, and what this pass added:**

| Gap | Fix |
|---|---|
| No "what should I do?" mode — only "what if X" | `agent.buildDecisionStrategies()` + `POST /api/decide`: 6 deterministic turnaround levers, ranked by the same policy |
| Safe thresholds only surfaced for boundary-*phrased* text | `GET /api/safe-limits/:profileId` — always-on panel, no phrasing needed |
| No document input | `POST /api/extract` — regex-based, auditable, MVP (CSV/pasted text → structured overrides) |
| No voice input | Browser `SpeechRecognition` API wired to the existing question field — zero new backend surface |
| No audit trail UI | "How did we reach this decision?" panel, built entirely from response fields already returned |
| No tests | 16 `node:test` cases covering hiring, revenue shocks, payment delays, negative cash, compound shocks, sensitivity applicability, and safe-threshold boundaries |
| No shareable output | `POST /api/share` + `GET /api/share/:id` (in-memory; swap for Redis/DB in production) |
| "Student cockpit" visual identity | Rebranded copy/labels (Aircraft → Business Profile, ATC Clearance → AI Recommendation, etc.), removed the scanline overlay, kept the legible dark-panel layout that was already functioning well |
| No PWA | `manifest.json` + `sw.js` (app-shell caching only — API calls always hit the network live) |

**What was intentionally left alone:** the slider-based "Adjust Your
Business" live controls, the two always-on charts, and the sensitivity bar
chart — these worked well and needed no changes.

**Later addition — Monte Carlo stress test:** every feature above still
answers "what happens if X" for one fixed set of assumptions. Added
`engine.monteCarloSimulate()` (400-trial, seeded/reproducible, zero LLM
involvement — see "Advanced features" #5 below) plus two endpoints and two
dashboard panels so the app also answers "how likely is that outcome,
really" instead of presenting a single deterministic line as certain.

## Prioritized plan (what shipped vs. what's future work)

**MUST HAVE (shipped):** core engine correctness + tests, compound scenarios
(pre-existing), deterministic recommendations, reverse simulation / safe
limits (now always-on), sensitivity analysis (pre-existing, unchanged).

**SHOULD HAVE (shipped):** decision-trace/audit panel, "what should I do?"
mode, document input MVP, voice input.

**NICE TO HAVE (shipped, kept intentionally minimal):** PWA manifest +
service worker, shareable scenario links (in-memory — fine for a demo,
would need a real datastore for production).

**Explicitly not built**, per the "don't overengineer" instruction: OCR for
scanned PDFs/images (CSV/pasted-text extraction covers the demo need without
adding a fragile vision pipeline), a persistent floating copilot widget
(the console + safe-limits panel already surface the same information
without adding a second competing UI surface), native mobile apps (PWA
covers "shareable through one URL, installable, works on mobile").

---

## Why this is agentic, not "just an LLM chatbot"

A chatbot answers a question with text. This system **acts**: it parses
intent, plans multiple courses of action, executes each one through a real
model, evaluates the outcomes, and commits to a recommendation — the
loop of *perceive → plan → act → evaluate* that defines an agent, not a
single autocomplete call.

Concretely, three things separate this from "an LLM guessing numbers":

1. **The arithmetic is never done by a language model.**
   All cash-flow math lives in [`backend/engine.js`](backend/engine.js) —
   plain JavaScript running real formulas (`runway = cash / net burn`,
   month-by-month propagation of hires/delays/drops). This file has zero
   calls to any LLM. You could delete every AI dependency from this repo
   and the engine would still produce correct, auditable numbers — and now
   there are unit tests (`backend/tests/engine.test.js`) proving it.

2. **The LLM (when used) only does two things: parse and phrase.**
   [`backend/agent.js`](backend/agent.js) optionally calls Claude to (a)
   turn free text into structured parameters, and (b) turn already-computed
   summary numbers into a plain-language explanation. It is explicitly
   instructed never to invent a financial figure — every number it's
   allowed to reference is handed to it after the engine has already
   calculated it. If no API key is configured, a deterministic rule-based
   parser and template-based explainer take over automatically — **the
   app is fully functional with zero AI calls**, which is the point: the
   intelligence is in the *engine + branching + decision policy*, not in
   the language model. The new "What should I do?" mode doesn't even need
   NLP parsing — it runs the business's own numbers through fixed
   deterministic levers — so it works identically with or without an LLM.

3. **It branches and decides, it doesn't just report.**
   For every parsed intent, the agent generates 2–3 distinct strategies
   (e.g. *hire all at once* vs *phased hiring* vs *delay hiring 3 months*),
   runs **each one** through the engine independently, ranks them by a
   defined policy (fewest critical cash-negative months → highest cash
   floor → highest ending cash), and surfaces the winner with the reasoning
   spelled out. That decision policy is what a human financial controller
   would actually do — the app automates the judgment call, not just the
   spreadsheet.

---

## Advanced features: why these deepen the agentic story

A static dashboard can show you a number. It cannot do any of the following
— they all require running the deterministic engine dozens of times and
reasoning about the results, which is exactly what an agent does and a
dashboard can't.

### 1. Sensitivity analysis — "what moves this outcome the most"

After the engine picks a recommended scenario, `engine.sensitivityAnalysis()`
re-runs that exact scenario multiple times, nudging one input at a time
(growth rate ±20%, fixed costs ±10%, payment terms ±15 days, cost-per-hire
±10%) while holding everything else constant, and measures how much each
nudge moves the outcome. The result is a ranked list — visualized as a
horizontal bar chart under the scenario cards — telling the founder which
lever actually matters for *this specific* decision.

**Endpoint:** `POST /api/sensitivity` — `{ profileId, question }`

### 2. Break-even / safe-zone finder — "what's the most I can safely do"

`engine.findSafeThreshold()` binary-searches the space of possible
headcounts (or revenue-drop magnitudes) to find the exact boundary where
the business stops being "safe" (cash never goes negative, and at least N
months of runway remain at the end of the horizon).

Ask it directly — "how many employees can I afford to hire?" — and the
agent detects the boundary phrasing and routes to this engine function
automatically. **It's now also always visible** as a "Safe Limits" panel
on the dashboard (`GET /api/safe-limits/:profileId`), computed against
whatever numbers (profile defaults or live slider overrides) are currently
active — no need to phrase a boundary question in free text at all.

**Endpoints:** `POST /api/breakeven` (single shockType, from free text
detection or a direct UI control); `GET /api/safe-limits/:profileId`
(combined hire + revenue-drop thresholds in one call, new in this pass).

### 3. Compound / stacked scenarios — reasoning over multiple shocks at once

"What if I hire 10 people **and** my biggest customer pays 30 days late?"
requires the agent to recognize two independent shocks in one sentence,
build a strategy for each, and combine them into coherent joint strategies
(e.g. pairing "phased hiring" with "negotiate partial upfront payment" into
one branch). The merged shocks flow through the exact same deterministic
`engine.simulate()` as any other scenario.

**No new endpoint needed** — `POST /api/whatif` transparently detects and
handles compound questions.

### 4. "What should I do?" — decision mode (new)

Not every question is "what if X happens" — sometimes it's "my company is
losing money, what are my options?" `agent.buildDecisionStrategies()`
generates six deterministic levers (hold course, cut fixed costs 15%,
freeze hiring & cut payroll 10%, raise prices 10%, invest more in sales,
or combine cost cuts with a price increase), runs **every one** through
`engine.simulate()`, and ranks them with the identical policy used
everywhere else. No free-text parsing is required — the input is the
business's own current numbers, so this mode is 100% deterministic
end-to-end regardless of whether an LLM is configured.

**Endpoint:** `POST /api/decide` — `{ profileId, overrides }`

### 5. Monte Carlo stress test — "how likely is this outcome, really"

Every other feature above answers "what happens if X" for one fixed set of
assumptions — the single line on the "Revenue vs Costs" chart is one
plausible future, presented as if it were certain. `engine.monteCarloSimulate()`
runs that same `simulate()` function 400 times per view, each time with
independently randomized-but-realistic growth rate, month-to-month demand
noise, fixed-cost overrun, and a chance of a customer paying late, then
reports the SPREAD of outcomes (a percentile "fan chart" per month) and a
plain "X% of simulated futures never ran out of cash" survival probability.

Still zero LLM involvement, and still fully auditable: the randomness comes
from a seeded PRNG (`mulberry32`), so the same seed always reproduces the
exact same 400 trials — "run it again" gives an identical answer, not a
different one, and every assumption used (trial count, seed, each
distribution's width) is returned in the response for the UI to disclose
rather than hide.

Shown two ways on the dashboard:
- **Always-on** ("Cash Flow Confidence" panel) — stress-tests the CURRENT
  baseline (profile defaults or live slider overrides), independent of
  asking any question.
- **Per-recommendation** ("How Solid Is This Recommendation?" panel) —
  after a what-if question or a "What should I do?" run, stress-tests the
  specific recommended scenario's shocks, answering "given everything ELSE
  that could plausibly happen too, how solid is this plan really?" as a
  companion to sensitivity analysis (which finds what matters most, but
  doesn't say how likely a bad outcome actually is).

**Endpoints:** `GET /api/montecarlo/:profileId` (baseline, mirrors
`/api/safe-limits`); `POST /api/montecarlo` (recommended scenario, `mode:
'whatif'` default or `mode: 'decide'`, mirrors `/api/sensitivity`).

### 6. Financial document input (MVP)

`POST /api/extract` takes pasted or uploaded (client-side `FileReader`,
CSV/plain-text) financial figures and extracts labeled numbers — revenue,
cash, payroll, fixed costs, receivables — including ₹-lakh/crore and k/m
suffixes, via regex, **not an LLM**. A wrong match is a debuggable pattern
miss, not a hallucination. Extracted numbers apply as slider overrides,
feeding the exact same simulation engine as manual input.

### 7. Voice input

The 🎙 button next to the question field uses the browser's native
`SpeechRecognition` API to transcribe speech into the existing text input —
no new backend surface, no added dependency, and it degrades gracefully
(button disables itself) in browsers without support.

### 8. Decision trace / auditability

Every result screen includes a "How did we reach this decision?" panel,
built entirely from fields already present in the API response — intent
parsing, scenario count, simulation, risk evaluation, safe-threshold
analysis (when triggered), recommendation, and explanation — making the
"LLM = interpretation + explanation, engine = calculations" principle
visible in the product itself, not just in comments.

### 9. Shareable scenarios

After running a scenario, "🔗 Share this scenario" posts the full response
to `POST /api/share` and returns a short link (`?share=ID`); opening that
link replays the exact result via `GET /api/share/:id`. Stored in-memory
for the hackathon demo — swap for Redis/Postgres for production
persistence across restarts.

---

## Architecture

```
financial-flight-simulator/
├── backend/
│   ├── engine.js       # Deterministic financial engine (pure math, no LLM)
│   │                     — simulate(), sensitivityAnalysis(), findSafeThreshold()
│   ├── agent.js         # Agentic layer: parse intent(s) → build scenarios → recommend
│   │                     — handles compound questions, boundary detection,
│   │                       and "what should I do?" decision strategies
│   ├── profiles.js       # Mock business profiles (D2C, Services SMB, SaaS)
│   ├── server.js         # Express API — see endpoint table below
│   ├── tests/
│   │   └── engine.test.js  # 16 unit tests on the deterministic engine (node --test)
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── index.html         # Dashboard shell
│   ├── style.css           # Dark fintech-panel visual theme
│   ├── app.js               # Fetches API, draws gauge/chart/risk-strip/trace/safe-limits
│   ├── manifest.json         # PWA manifest
│   ├── sw.js                  # Service worker (app-shell caching only, never caches /api/*)
│   └── icon-192.png, icon-512.png
├── README.md
└── DEMO_SCRIPT.md
```

### API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/profiles` | List mock business profiles |
| `GET /api/baseline/:profileId` | No-shock baseline trajectory (accepts slider overrides as query params) |
| `POST /api/whatif` | Main pipeline: parse → branch → simulate → recommend → explain |
| `POST /api/sensitivity` | Sensitivity analysis for the recommended scenario of a given question |
| `POST /api/breakeven` | Standalone safe-threshold search for a given shockType |
| `GET /api/safe-limits/:profileId` | **New** — combined hire + revenue-drop safe thresholds, always-on |
| `POST /api/decide` | **New** — "what should I do?" mode: 6 deterministic levers, ranked |
| `POST /api/extract` | **New** — regex-based structured extraction from pasted/uploaded text |
| `POST /api/share` / `GET /api/share/:id` | **New** — shareable scenario links (in-memory) |

### Request flow for a "what if" question

```
User types (or speaks) a question
      │
      ▼
POST /api/whatif  { profileId, question }
      │
      ▼
agent.parseIntent(question)  ──► one OR MORE structured intents
      │                             (LLM if configured, else rule-based regex parser)
      ▼
agent.buildScenarios(intents) ──► 2-3 named strategies, each a `shocks[]` array
      │
      ▼
engine.simulate(profile, shocks)  ──► REAL month-by-month math for EACH scenario
      │
      ├──► agent.detectBreakevenIntent(question) matched?
      │        └─► engine.findSafeThreshold() ──► binary-searched safe threshold
      │
      ▼
agent.pickRecommendation(results) ──► ranks by risk-months → cash floor → end cash
      │
      ▼
agent.getExplanation() ──► plain-language write-up (LLM or template)
      │
      ▼
JSON response → frontend renders chart / risk strip / recommendation / decision trace
```

### Request flow for "What should I do?"

```
Current business numbers (profile + live overrides)
      │
      ▼
POST /api/decide  { profileId, overrides }
      │
      ▼
agent.buildDecisionStrategies(profile) ──► 6 fixed deterministic levers
      │
      ▼
engine.simulate(profile, shocks) ──► REAL math for EACH lever
      │
      ▼
agent.pickRecommendation() + agent.getExplanation() ──► same ranking/explaining code as /api/whatif
      │
      ▼
JSON response → same rendering pipeline as a "what if" result
```

---

## Running it locally

Requires Node.js 18+ (for native `fetch`).

```bash
cd backend
npm install
cp .env.example .env      # optional — leave LLM_PROVIDER=none to run fully offline
npm start
```

Then open **http://localhost:4000** in your browser. The Express server
serves the frontend directly, so there's nothing else to run.

### Running the tests

```bash
cd backend
npm test
```

Runs 16 `node:test` cases against `engine.js` — real financial-logic
assertions (hiring cost timing, revenue-shock magnitude, payment-delay
deferral, negative-cash risk flagging, compound-shock combination,
sensitivity ranking order, and safe-threshold boundary correctness), not
just HTTP status checks.

### Choosing an LLM provider (optional)

The app supports three interchangeable providers for the parsing/explanation
steps only, selected with a single env var in `backend/.env`:

```
LLM_PROVIDER=none | anthropic | ollama
```

| `LLM_PROVIDER` | What it does | Requires |
|---|---|---|
| `none` (default) | Skips LLM calls entirely — rule-based parser + templated explanation | Nothing |
| `anthropic` | Calls the Anthropic API for parsing & phrasing | `ANTHROPIC_API_KEY` in `.env` |
| `ollama` | Calls a local Ollama server for parsing & phrasing | Ollama running locally with a model pulled |

Whichever provider you pick, if it fails for any reason (missing key,
Ollama not running, model not pulled, timeout, malformed response), the
request **silently falls back to the rule-based path** rather than
returning an error. The "How did we reach this decision?" trace panel and
the UI's footer note always report which provider actually produced the
result you're looking at.

### Running with local Ollama

Beyond being free to run, local Ollama matters for this use case for a real
reason: **the financial data in your "what if" question never leaves your
machine.** For a fintech tool, that's a genuine privacy/compliance angle.

```bash
ollama pull llama3.1:8b
```
Then in `backend/.env`:
```
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b
```
Pre-warm before a live demo: `ollama run llama3.1:8b ""`.

---

## Deployment

This is a single Node/Express process that also serves the static frontend
— no separate frontend build step, no reverse proxy required.

**Simplest path — Render, Railway, or Fly.io (single web service):**
1. Push this repo to GitHub.
2. Create a new Web Service pointing at `backend/` as the root (or set the
   start command's working directory).
3. Build command: `npm install`. Start command: `npm start`.
4. Set environment variables in the platform's dashboard — `PORT` is
   usually auto-injected; set `LLM_PROVIDER` and `ANTHROPIC_API_KEY` only
   if you want cloud LLM parsing/explanation (the app runs fully without
   them).
5. Deploy. The platform-assigned URL serves both the API and the frontend.

**Checklist before deploying (already satisfied by this codebase):**
- No API keys hardcoded — `ANTHROPIC_API_KEY` is read from `process.env`
  only, via `.env` locally or the platform's secret manager in production.
- `PORT` is read from `process.env.PORT` with a local fallback.
- No hardcoded `localhost` URLs in the frontend — `app.js` uses relative
  `/api/...` paths throughout, so it works unmodified behind any domain.
- CORS is a non-issue because the frontend is served by the same Express
  process as the API (no cross-origin requests).
- Every LLM call path has a deterministic fallback, so a missing/invalid
  API key degrades gracefully instead of 500ing.
- `sw.js` never caches `/api/*` responses, so a redeploy's new numbers are
  never masked by stale cached data.

**PWA installability:** once deployed over HTTPS (required for service
workers outside `localhost`), visiting the URL on mobile offers "Add to
Home Screen" — the whole app is reachable through the single deployed URL,
per the "PWA, not a native app" requirement.

---

## How this would plug into Razorpay's actual product surface

This prototype uses three mock business profiles so the demo works with
zero setup, but every part of it is structured to plug into real data:

- **`profiles.js` → Razorpay transaction & settlement data.**
  Replace the mock `startingCash`, `monthlyRevenue`, and
  `customerConcentration` fields with live aggregates pulled from a
  merchant's Razorpay Payments/Payouts history (rolling revenue, top-N
  customer concentration, average days-to-settle). The engine's inputs
  don't change shape — only their source does.

- **`agent.js`'s "Bridge with short-term credit" scenario → Razorpay
  Capital.** The scenario already models drawing a credit line to cover a
  payment gap and repaying it with interest. In production, this branch
  would call Razorpay Capital's underwriting/lending API to fetch the
  merchant's *actual* eligible credit line and real interest rate.

- **`engine.js` is data-source agnostic.** It only needs five numbers
  (cash, revenue, fixed costs, payroll, growth) and a shocks array — it
  doesn't care whether those numbers came from a mock profile, a pasted
  bank statement via `/api/extract`, or a live Razorpay merchant dashboard.

- **`/api/extract`'s regex extractor → a real document-intelligence
  pipeline.** In production this would be backed by a proper OCR/document
  parsing service for scanned P&Ls, bank statements, and invoices — the
  MVP here proves the "extraction produces structured data, never lets the
  LLM touch the math" architecture without building a fragile vision
  pipeline for a hackathon deadline.

- **Notification hook.** Because the engine already computes a month-level
  risk flag (`safe` / `warning` / `critical`), a production version could
  proactively push a "your runway drops to critical in month 5" alert via
  Razorpay's merchant notification channels.

---

## Hackathon pitch

**1-line pitch:** Ask a financial question in plain English — our AI turns
it into a measurable scenario, a deterministic engine runs the real
numbers, and the system tells you the safest path and why, with every
number traceable back to code, not a language model.

**30-second pitch:** Founders don't need another chatbot that guesses at
their cash flow — they need a financial controller that never gets the
arithmetic wrong. This app takes a plain-English question like "can I
afford to hire 10 engineers if my biggest customer pays 30 days late?",
extracts the assumptions, branches them into concrete strategies, runs each
one through a real 12-month cash-flow simulation, finds the exact safe
hiring/spending boundary via binary search, ranks the strategies by risk,
and explains the recommendation — with the LLM only ever interpreting and
phrasing, never calculating.

**60-second pitch:** Most "AI finance" tools are a chat window bolted onto
a spreadsheet — the model both reasons about your business and does the
arithmetic, which means a hallucinated number looks exactly as confident as
a correct one. This project inverts that: a deterministic engine
(`engine.js`) owns 100% of the math — runway, burn, compound shocks, safe
thresholds, sensitivity — and is unit-tested to prove it. The AI layer only
does two things: turn a free-text question into structured parameters, and
turn already-computed numbers into a plain-English explanation. On top of
that, the product does things a static dashboard structurally cannot: it
reasons over compound multi-shock scenarios, it answers "what's the most I
can safely do" via reverse simulation (not just "what if"), and now it also
answers "what should I do?" directly — generating and ranking six
turnaround levers from the business's own numbers, no question required.
Every recommendation ships with a visible decision trace, so a founder (or
a judge) can see exactly which number came from where.

**Key innovation:** deterministic-engine-first architecture — the AI is
structurally prevented from inventing a financial figure, because it's
never given the opportunity to compute one.

**Why AI is necessary:** free-text financial questions are unstructured and
often compound ("revenue drops 20% AND my customer pays late AND I want to
hire") — turning that into precise simulation parameters, and turning
computed numbers back into a founder-readable explanation, is exactly the
kind of ambiguous-language task an LLM is suited for and rule-based parsing
alone eventually can't scale to.

**Why deterministic financial simulation is necessary:** a founder making a
real hiring or spending decision cannot afford a plausible-sounding wrong
number. Finance is exactly the domain where "the model sounded confident"
is not good enough — every output must be reproducible, testable, and
auditable back to a formula.

**Why this is relevant to fintech:** Razorpay already sits on the exact
data this tool needs (transaction volume, settlement timing, payroll via
RazorpayX, credit eligibility via Razorpay Capital) — this prototype is
structured so that swapping mock profiles for live merchant data, and the
placeholder credit-line scenario for a real Capital API call, requires no
architectural change, only a data-source swap.

**What makes this different from a generic LLM chatbot:** a chatbot
returns text. This system branches into multiple concrete strategies, runs
each independently through real math, ranks them by an explicit decision
policy, finds safe boundaries via search (not guesswork), and shows its
work — that's the perceive → plan → act → evaluate loop of an agent, not a
single autocomplete call.

---

## What to check if something looks wrong

- No numbers ever come from the LLM — if you suspect a figure is wrong,
  the bug is in `engine.js`, not in a prompt. Run `npm test` first; if a
  case there fails, that's your bug, reproducibly.
- If `LLM_PROVIDER` is `none` (or a configured provider fails), you'll see
  `(rule-based parser active)` in the UI's footer note under the input box
  — this is expected and the app is not degraded, just running its
  deterministic fallback path. Check the server console for a logged
  `[agent] ... failed, falling back to ...` line to see exactly why a
  configured provider didn't come through.
- `/api/extract` returning an empty `extracted` object means the regex
  patterns didn't recognize a label — check `notes` in the response for a
  hint, and prefer labels like "Revenue: ₹18.4L" per line.
- Shared scenario links (`/api/share/:id`) return 404 after a server
  restart — this is the documented in-memory-store limitation, not a bug.

---

# PERSONAL MODE — FinPilot Life

*(Added in this pass. Business Mode above is unchanged — see "Business
Mode regression" under Testing below.)*

## 1. Architecture changes — what was added and why

Personal Mode was added as a **second thin layer on top of the same
`engine.simulate()`/`engine.monteCarloSimulate()` primitives** Business
Mode already uses, rather than a parallel financial engine. Concretely:

```
Business Mode:   profiles.js        → agent.js        → engine.js
Personal Mode:   personalProfiles.js → personalAgent.js → personalEngine.js → engine.js
```

`personalEngine.js` maps a household's numbers onto exactly the shape
`engine.simulate()` already accepts (income→revenue, living expenses→fixed
costs, existing EMI→payroll, savings→starting cash — see the header
comment in that file for the full table), and expresses every personal
event (a down payment, a new EMI, a rent increase, an income shock) using
the engine's **existing** shock vocabulary (`one_time_cash`, `hire`,
`revenue_shock`). No new shock types were added to `engine.js`, and
`engine.js` itself was not modified at all.

Two things in `personalEngine.js` are NOT cash-flow simulation and are
therefore implemented as direct formulas rather than routed through
`engine.simulate()`, because they need compounding (property appreciation,
invested down payments, EMI amortization) that the engine's per-month
loop doesn't model: EMI/amortization math, and the goal/rental-yield
future-value formulas. These are pure, independently tested functions.

## 2. New files / components

Backend:
- `backend/personalEngine.js` — the deterministic personal-finance layer (mapping, affordability, safe EMI, buy-vs-rent, rental yield, goals, health score, stress-test wrapper).
- `backend/personalAgent.js` — free-text/voice parsing for Personal Mode (rule-based, with the same optional Anthropic assist pattern as `agent.js`).
- `backend/personalProfiles.js` — three demo household profiles.
- `backend/tests/personalEngine.test.js` — 30 unit tests for the above.
- New routes in `backend/server.js` under `/api/personal/*` (listed below).

Frontend (all inside the existing `index.html` / `app.js` / `style.css` —
no new files, per the "same product" requirement):
- Header mode toggle (`Business` / `Personal`).
- `#personalMode` main section: snapshot + health score, collapsible
  profile form, six feature cards, six feature-detail panels (Can I
  Afford It?, Buy vs Rent, Safe EMI, Rental Analyzer, Goals, Stress Test),
  and the "Ask Your Personal Financial Controller" console with voice
  input and example chips.

## 3. Shared engine — what Business and Personal now share

Both modes share, unmodified:
- `engine.simulate()` — every personal cash-flow number (EMI/ownership
  cost trajectories, rent-escalation paths, income-shock outcomes) is a
  real call to this function, not a re-derivation.
- `engine.monteCarloSimulate()` — the Personal Stress Test reuses this
  directly, just with household-flavored noise parameters (income
  volatility instead of revenue growth uncertainty, an "unexpected
  expense" probability instead of a late-paying customer).
- The shock vocabulary (`one_time_cash`, `hire`, `revenue_shock`) — a
  down payment is a negative `one_time_cash`; a new EMI is a `hire` shock
  (a new recurring monthly cost from a given month, which is exactly what
  `hire` already models); a pay cut is a `revenue_shock`.
- The `materializeCostAdjustments()`-style pattern of expressing a
  recurring cost change as a repeated per-month `one_time_cash` shock —
  reused for rent escalation in Buy vs Rent.
- The recommendation-policy *shape* from `agent.pickRecommendation()`
  (safety gate first, then a decision preference) — Personal Mode's
  affordability ranking follows the same two-step pattern, extended with
  an emergency-fund-specific safety gate instead of a "critical months"
  gate.
- The provider-fallback plumbing in `agent.js` (`getProvider()`) — reused
  by `personalAgent.js` for its optional LLM-assisted parse, so Personal
  Mode never needed its own LLM_PROVIDER/timeout/fallback logic.
- The `renderMonteCarloFanChart()` chart renderer, `fmtMoney()`, and the
  general "call the API, render whatever it returns" pattern in `app.js`.

## 4. Personal features implemented

- ✅ Can I afford it? (three-branch: buy now / wait & save / buy cheaper)
- ✅ Buy vs Rent (5/10/15-year net worth + break-even year)
- ✅ Maximum Safe EMI (reverse binary search against the emergency-fund target)
- ✅ Rental Yield Advisor (gross vs. net vs. cash-flow-after-financing, kept explicitly distinct)
- ✅ Financial Goals (time-to-reach and required-monthly-saving, plus a contribution-rate comparison table)
- ✅ Personal Stress Test (Monte Carlo, reusing `engine.monteCarloSimulate()`)
- ✅ Voice input (reuses Business Mode's browser `SpeechRecognition` wiring, pointed at the Personal console — no new voice architecture)
- ✅ Document input — implemented as the **structured-input fallback** the
  spec explicitly allows: paste a property listing's text and
  `/api/personal/extract-listing` regex-extracts price/area/rent/
  maintenance/BHK. Image/vision extraction was deliberately not built —
  same reasoning as Business Mode's `/api/extract`: an unreliable vision
  pipeline is worse than a clean, auditable text fallback for this scope.
- ✅ "Ask Your Personal Financial Controller" — `/api/personal/ask`
  classifies the question, extracts numbers already present in the
  sentence (including compound "buy a house AND income drops 15%"
  questions), and routes to the right feature above.
- ✅ Financial Health Score with a "why" explanation, mirroring
  `engine.analyzeRisks()`'s weighted-deduction shape.
- ✅ Subtle, non-blocking financial disclaimer in the Personal Mode header.

## 5. Testing performed

- `npm test` runs both suites (`node --test tests/*.test.js`):
  **57 tests total, 57 passing** — the original 27 Business Mode tests
  (unchanged, unmodified file) plus 30 new Personal Mode tests.
- Personal test coverage specifically includes: EMI against a known
  reference value, amortization monotonicity, affordability's three
  branches all producing real engine summaries, the emergency-fund-breach
  detection on an unaffordable purchase, waiting increasing the down
  payment and lowering the EMI, safe-EMI scaling with income, safe-EMI
  correctly reporting "not safe yet" rather than a false number for an
  already-stretched budget, buy-vs-rent's three yearly checkpoints,
  buy-vs-rent explicitly NOT always favoring buying (a 0%-appreciation/
  high-return-investing case is included precisely to prove this), gross
  vs. net rental yield never inverting, goal time-to-reach responding
  correctly to different contribution rates, and the health score
  penalizing a household with no emergency fund more than a buffered one.
- Business Mode regression: ran the full pre-existing suite after every
  change to `server.js`/shared files; all 27 original tests still pass
  unmodified, and manual smoke tests confirmed `/api/whatif`,
  `/api/risk-radar/:id`, and `/api/baseline/:id` are byte-for-byte the
  same code path as before this pass.
- Manual end-to-end smoke test of the exact demo flow from the spec (see
  Demo instructions below) — confirmed via `curl` against a running
  server, not just the unit tests.

## 6. Demo instructions (under 90 seconds)

1. Load the app — it opens on **Business Mode** by default. Click
   **Personal** in the header toggle. The demo household (₹1.5L income,
   ₹12L savings, ₹25K rent) is pre-loaded — no data entry needed.
2. Point at the snapshot row and the Financial Health score (starts
   healthy, ~96/100 — click the score to expand the category breakdown).
3. In "Ask Your Personal Financial Controller", type or click the first
   example chip: **"Can I afford a ₹70 lakh house?"**
   → Shows the three-branch comparison. With this household, buying now
   fails the emergency-fund check because the down payment alone exceeds
   savings — the system recommends a cheaper property instead and says
   exactly why.
4. Click the **"Buy vs rent"** example chip: **"Should I buy a ₹75 lakh
   house or continue renting for ₹30K?"**
   → Shows the break-even year (~year 8) and the 5/10/15-year net-worth
   table.
5. Click the **"Safe EMI"** chip → shows the maximum EMI this household
   could safely take on today.
6. Open the **Rental Analyzer** feature card, enter a price (or paste
   `"2BHK ₹75 lakh, 1100 sq ft, rent ₹28,000, maintenance ₹3,500"` into
   the listing box and click Extract) → shows required rent for 3/4/5%
   gross yield, with net yield and cash-flow-after-financing kept visibly
   distinct from the gross figure.
7. Open **Stress Test** and click **Run 400-trial stress test** to show
   the fan chart and survival probability — the same visual language as
   Business Mode's Monte Carlo panel.

Total: 6 API-backed features, one continuous conversation, zero page
reloads, and Business Mode is one click away, unaffected the entire time.

