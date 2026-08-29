# Demo Script — 3 Minutes

Goal: show judges this is a **decision-support agent**, not a chatbot or a
static dashboard, in under 3 minutes, then hand them the controls.

---

### 0:00 – 0:20 | Open on the problem (don't open on the product)

> "Every SMB dashboard shows you where your cash *is*. None of them show
> you where it's *going* to be if you make a decision. Founders make
> hiring, pricing, and payment-term calls with a spreadsheet and a guess.
> We built something that actually runs the numbers for you — for every
> option, not just one."

Switch to the app. It's already loaded on the **D2C Startup** profile.

### 0:20 – 0:45 | Orient on the instruments

> "This is the current state of the business — cash on hand, burn,
> growth — and this runway gauge is computed live from a real financial
> engine, not an estimate. Right now we're sitting in the safe zone."

Point to the gauge and the stat panel. Mention the profile switcher
briefly ("we've pre-loaded a D2C brand, a services SMB, and a SaaS
startup, each with different risk profiles — long payment terms, thin
margins, aggressive hiring").

### 0:45 – 1:30 | Ask the first "what if" — show the branching

Type (or click the chip): **"What if I hire 10 employees?"**

> "The system doesn't just answer — it parses this into a structured
> hiring event, generates three different strategies for actually doing
> it, and runs *each one* through the same deterministic engine. This is
> the differentiator: it's not one projection, it's a decision tree with
> real numbers on every branch."

Point at the chart: baseline (dashed) vs. three colored paths, recommended
one highlighted. Point at the risk strip.

> "And it doesn't just show you the branches — it picks one. 'Delay hiring
> by 3 months' is recommended here because it keeps the highest cash floor
> and avoids any risky months, and it tells you *why* in plain language."

Read the ATC Clearance recommendation line aloud.

### 1:30 – 2:00 | Show it's not fragile — a harder scenario

Type: **"What if my biggest customer pays 15 days late?"**

> "This one's interesting because one of the three strategies it generates
> is drawing a short-term credit line to bridge the gap — which, in a real
> Razorpay integration, is exactly the moment you'd want to surface a
> Razorpay Capital offer. The recommendation engine already models the
> repayment and interest cost of that credit line in the projection."

Point at the new **sensitivity bar chart** below the scenario cards.

> "And underneath, it's already telling us what actually drives this
> outcome — for this business, it's growth rate, not the payment delay
> itself. That's not a canned insight; it re-ran the simulation a dozen
> times, nudging one variable at a time, to find that out."

### 2:00 – 2:30 | Hand it to the judge (live input moment — THIS is the strongest moment in the demo)

> "Go ahead — ask it anything. Try a compound question, like 'what if I
> hire 10 people and my biggest customer pays 30 days late' — or a
> boundary question, like 'how many people can I actually afford to
> hire?' Or just make up your own."

Let the judge type a free-text scenario into the input box themselves and
watch the branches regenerate live. **Strongly prefer letting the judge's
own question land on a compound or boundary phrasing if they offer one** —
these are the two moments that most clearly prove this isn't a fixed demo
path with canned responses:

- **Compound** ("X and Y"): the agent visibly splits the sentence into two
  shocks, builds a strategy for each, and merges them into combined
  branches — point out the "COMBINED" tag on the scenario cards and read
  a merged name aloud (e.g. "Phased hiring + negotiated payment terms").
- **Boundary** ("how many can I afford"): a distinct green callout appears
  above the chart with a direct answer — "You can safely hire up to N
  people without your runway dropping below 6 months" — computed by a
  binary search over the engine, not a lookup table.

If the judge's own phrasing doesn't happen to trigger either, that's fine
— use one of the dashed example chips ("Hire 10 + customer pays late" or
"How many can I afford to hire?") right after to show both explicitly.

### 2:30 – 2:50 | The technical differentiator, fast

> "Two things worth knowing under the hood: first, every number on this
> screen comes from a plain JavaScript financial engine — month-by-month
> cash propagation, real formulas, zero LLM involvement in the arithmetic.
> Second, the language model — when we use one — only does two jobs:
> turning your sentence into structured parameters, and turning the
> computed results into plain English. It never invents a number. That
> means this works completely offline too, which it's doing right now."

> "And that's swappable, not hardcoded — this same app runs identically on
> a cloud LLM, on a fully local model with Ollama so financial data never
> leaves the device, or with no LLM at all. That's a maturity signal, not
> a gimmick: the actual intelligence — the engine, the branching, the
> decision policy — never depends on which provider is plugged in."

### 2:50 – 3:00 | Close on the product surface

> "Every input here — cash, revenue, customer concentration — is
> structured to plug directly into Razorpay's transaction data, and the
> credit-bridge scenario is a natural fit for Capital's lending decision
> support. This isn't a hackathon toy bolted onto an API call — it's a
> financial controller that happens to be conversational."

---

### 3:00 – 3:30 | Bonus, if time allows: new features

Extend the demo with the new features added in this pass:

> "Two more things worth 30 seconds each. First — switch to 'What should I
> do?' mode." Click it, hit **Get Recommendations** with no text typed. "No
> question needed — it just took the business's own numbers and ranked six
> real turnaround levers: cut costs, freeze hiring, raise prices, invest in
> sales, or combine them. Same deterministic engine, same ranking policy."

> "Second — scroll up to Safe Limits." Point at the three always-on cards.
> "This used to only show up if you phrased a boundary question exactly
> right. Now it's just always there — reverse-simulated from whatever
> numbers are currently active, including the sliders."

> "And every result has a 'How did we reach this decision?' trace at the
> bottom — that's the audit trail: intent parsing, scenario generation,
> simulation, risk evaluation, recommendation, explanation, each one naming
> what actually produced it. Nothing on this screen is a black box."

---

## Backup talking points (if asked)

- **"What's the 'What should I do?' mode — isn't that just more what-ifs?"**
  No — it doesn't parse a question at all. It takes the business's CURRENT
  numbers and runs them through six fixed, deterministic levers (cost cuts,
  hiring freeze, pricing, sales investment, combination), so it works
  identically whether or not an LLM is configured. It answers "what are my
  options" rather than "what if X happens."

- **"Is the document upload doing OCR / calling an LLM to read the file?"**
  No — it's a regex-based structured extractor (`/api/extract`) that looks
  for labeled numbers like "Revenue: ₹18.4L". If it misses something, the
  bug is a debuggable pattern-match miss, not a hallucination. It's an
  intentional MVP scope — a production version would add real
  document-intelligence for scanned PDFs, but the "extraction produces
  structured data, never lets AI touch the math" architecture is already
  correct and wouldn't change.


- **"Why not just have the LLM estimate the cash flow directly?"**
  Because financial decisions need to be auditable and reproducible. An
  LLM can hallucinate a plausible-sounding number; a deterministic engine
  cannot — the same inputs always produce the same output, and every
  number can be traced back to a formula.

- **"What happens if the API key isn't set / API is down?"**
  Nothing breaks. The rule-based parser and templated explanations take
  over transparently — the footer note under the input box says which
  mode is active. The engine and scenario branching are unaffected either
  way, since neither depends on the LLM.

- **"How would this scale to real merchant data?"**
  See the README's "How this would plug into Razorpay's actual product
  surface" section — the engine's input shape (`cash, revenue, fixed
  costs, payroll, growth`) is deliberately data-source-agnostic.

- **"What's actually new about the sensitivity chart / breakeven finder /
  compound questions — couldn't a dashboard show that too?"**
  No — all three require *running the simulation many times and reasoning
  over the results*, which a static dashboard by definition can't do:
  sensitivity analysis re-runs the engine ~8 times with perturbed inputs
  to rank what matters; the breakeven finder binary-searches dozens of
  simulated headcounts or revenue-drop magnitudes to find an exact safe
  boundary; and compound questions require parsing two shocks out of one
  sentence and deciding how to merge their strategies together. A
  dashboard shows you a number you already have. This shows you numbers
  you'd otherwise have to build a spreadsheet model to find.

- **"Is the sensitivity/breakeven math also deterministic, or does the LLM
  touch it?"**
  Completely deterministic — `engine.sensitivityAnalysis()` and
  `engine.findSafeThreshold()` only ever call `engine.simulate()` with
  different inputs and read off the results. Same guarantee as the rest of
  the engine: zero LLM involvement in any number shown.
