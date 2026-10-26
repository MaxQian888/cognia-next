---
name: evidence-driven-dev
description: >-
  Uncertainty-aware, evidence-driven development for cognia-next: triage how much is unknown, then separate the user's
  observations, cause guesses and proposed solution, discover the real complexity (unknown allowed, budgeted spikes),
  derive verification obligations from risks, decide the next action from evidence (implement / spike / diagnose /
  harden / escalate / stop), verify independently, and track residual risk and the real outcome in a checked ledger
  under docs/evidence/. Use at the start of any non-trivial change, especially when the request names a fix or cause
  rather than a problem ("加个自动重试", "加缓存就快了"), when you can't yet say how big a task is, when it touches data,
  sync, auth, wire protocols, the three shells, or other irreversible surfaces, and again before declaring done or
  when new evidence contradicts the plan. Triggers: 需求分析, 问题发现, 真正的问题是什么, 这个需求对不对, 复杂度评估,
  风险分析, 该验证什么, 验证义务, 证据, 残余风险, 到底解决了没有, spike, evidence ledger. Skip for one-line or
  purely mechanical edits.
---

# Evidence-driven development

AI makes building fast, but it doesn't remove the two ways engineering fails:
**building the thing wrong** (bad design or implementation) and **building the
wrong thing** (a precise implementation of a guess). Fast building can even
lock a wrong problem framing into architecture sooner. This skill puts a
problem model, a complexity profile, risk-derived obligations and independent
evidence ahead of commitment. How much of it runs scales with how much is
unknown and how much a mistake would cost.

It orchestrates what already exists in this repo (`grilling`, `doubt-driven`,
`preflight`, the six auditors, `map-requirement-flow`, the gate registry). It
does not replace them. `CLAUDE.md`'s Working Rules still govern every step,
including asking the user in Chinese and narrating in English.

## 0. Triage (always; one minute)

Answer four questions from what you already know:

1. **Problem or prescription?** Does the request state a problem/outcome, or
   a cause guess / named solution ("it's the network, add retry")?
2. **Sizable?** Can you say now which layers and modules this touches?
3. **Catalog risk?** Does it touch an irreversible or shared surface: data or
   schema, sync, auth/credentials, wire protocols, plugin SDK, external sends,
   or behavior across browser/Tauri/Capacitor? (See the catalog in
   `references/risk-evidence.md`.)
4. **Verifiable here?** Can correctness be shown headlessly (jest/cargo/gates),
   or does it need a real shell, device, provider, server or person?

Pick the lightest lane that fits, and state it in one line:

| Lane         | When                                                                                     | What runs                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Quick**    | problem is clear, sized, no catalog risk, verifiable here                                | No ledger. Build → `preflight` → gates. Done.                                                                 |
| **Standard** | one answer is uncertain                                                                  | Ledger. Problem frame + complexity profile + catalog risks → obligations. `doubt-driven` only for high risks. |
| **Deep**     | prescription with costly consequences, several unknowns, or high irreversible risk       | Full loop: competing hypotheses, spikes, lens + fresh failure hunt, independent and real-env verification, `grilling`/ADR. |

Proportionality is part of correctness. Turning a clear, reversible task into a
research project is a failure, and so is treating a user's guess as a fact
because it was phrased as a requirement. If unsure between two lanes, take the
heavier one for the *discovery* stages only. They are cheap, and you can drop
back to building once the frame is clear.

## The loop

Stages run in order the first time, but any stage can send you back to an
earlier one (see "Re-entry"). Load a reference only when you enter its stage.

| Stage                         | Load                                                  | Produces (ledger section)                         |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| 1. Problem discovery          | `references/problem-discovery.md`                     | Knowledge (O/H/G/C/A/Q), Problem frame, first M   |
| 2. Complexity discovery       | `references/complexity-discovery.md`                  | Complexity profile; spike definitions             |
| 3. Risk & evidence discovery  | `references/risk-evidence.md`                         | Risks, Verification obligations                   |
| 4. Decide next action         | the table below                                       | a Decisions row                                   |
| 5. Spike / experiment         | `references/complexity-discovery.md` (spikes)         | state changes in Knowledge; a new D row           |
| 6. Controlled implementation  | `CLAUDE.md` rules + domain skills (`dexie-migration`, `workflow-node`, `jest-gotchas`, `mattpocock-skills:tdd`, …) | code + co-located tests; obligations turn into tests/gates |
| 7. Independent verification   | `references/verification-and-outcome.md`              | obligation Evidence + Status                      |
| 8. Residual risk & outcome    | `references/verification-and-outcome.md`              | Residual risks, Outcome; ledger Status            |

In the Standard lane, stages 1–3 can each be a few rows. The value is in
separating observed from guessed and in writing obligations *before* building,
not in volume.

## 4. Deciding the next action (progressive commitment)

Commit only as far as the evidence supports. Record each decision as a D row
with the IDs it rests on and the evidence that would reverse it:

| Current state                                              | Action (ledger vocabulary)          |
| ---------------------------------------------------------- | ----------------------------------- |
| Goal clear, easy to verify, low risk, reversible           | `implement`                         |
| A technical-feasibility unknown could change the route     | `spike`                             |
| The problem definition itself is uncertain                 | `diagnose` (gather O, discriminate H) |
| Known high risk that can be isolated                       | `experiment` in a sandbox / worktree / flag |
| Permissions, security, or irreversible side effects        | `harden`: stronger independent verification + explicit user authorization |
| A critical risk can't be verified and its loss is unacceptable | `escalate` (domain expert / user), `scope-down`, or `stop` |
| Enough evidence; remaining risk accepted                   | `implement` the next increment, or `ship` |

**Stop exploring when more information wouldn't change the decision.** Before
another round of discovery, ask: "could any result of this change what I do
next?" If not, and the next step is low-risk and reversible, proceed. If an
unverified assumption could cause major rework, data loss, or a security
incident, verifying it first is usually the better use of time.

`ledger.mjs check` warns when an `implement`/`ship`/`harden` decision rests on
Hypothesized, Unknown or Contested items, and errors when it rests on an
Invalidated one.

## The ledger

One Markdown file per Standard/Deep task, committed with the code, so the
reasoning travels with the change:

```bash
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs new <kebab-slug> --lane standard --request "<user's exact words>"
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/<file>.md          # after each edit round
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/<file>.md --final  # before claiming done
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs open                                    # everything unresolved, all ledgers
```

Before creating one, `ls docs/evidence/` and reuse an open ledger for the same
problem. A follow-up belongs in the same ledger, not a new one.

**Knowledge states.** Each item is Observed, Hypothesized, Verified,
Contested, Unknown or Invalidated (goals: Proposed/Agreed/Revised; questions:
Open/Answered). Every state needs a Basis: source, scope and date. "Verified
on macOS with provider X on 2026-10-21" is a different claim from "verified".

**Dependencies are the point.** Fill in "Depends on" and "Based on". "Based
on" lists only what a decision *assumes* still holds. Name ruled-out
hypotheses in the decision text instead, so that an invalidated assumption
always means "reopen". When an
item becomes Invalidated, walk everything that depends on it: re-mark
dependents Contested or Hypothesized, reopen decisions resting on it, and
re-run obligations whose evidence assumed it. `check` catches what you miss.
That propagation is what a dependency ledger gives you that a chat summary
doesn't.

**Status** moves exploring → building → verifying → closed. From `verifying`
on, every non-passed obligation must appear in Residual risks. `closed`
requires residuals accepted or closed and outcomes measured or carried. Commit
the ledger with explicit paths (`git add docs/evidence/<file>.md …`; Rule 8).
Any long-lived pending item gets a one-line memory pointer to the ledger.

## Re-entry: when to go back

Going back is expected. Re-enter the earliest stage the new evidence touches,
and record why in a D row:

- an observation contradicts the selected hypothesis → stage 1;
- the user revises the goal or answers a value question differently → stage 1;
- an unexpected dependency/consumer, platform limit, or out-of-scope test
  failure appears → stage 2 (re-rate complexity) then 4 (decide again);
- a new risk surfaces mid-build, or an obligation turns out to test the wrong
  property → stage 3;
- an outcome comes back `not-met` → stage 1. The frame was wrong, not just the code.

## Talking to the user

Don't hand them a form. Most users can't rate complexity or write a test plan,
and asking them to is how the knowledge burden lands back on them. Do the
discovery yourself (facts are your job), then bring decisions to them in
Chinese, framed as:

- 我们观察到了什么 / 目前有哪些可能的解释 / 什么还不清楚
- 下一步最有价值的实验或检查是什么
- 继续推进要承担什么风险
- 哪些决定需要你确认 (goals, value trade-offs, accepting residual risk, authorizing high-impact actions)

Value judgments, risk acceptance and high-impact authorization stay with the
human. Evidence-gathering, hypothesis generation and checking are yours.

## How this fits the existing tools

| Need                                              | Use                                                         |
| ------------------------------------------------- | ----------------------------------------------------------- |
| converge a design with the user                   | `grilling` (seed it with the Knowledge table)                |
| make a product flow behaviorally complete         | `map-requirement-flow`                                       |
| write the reviewable technical proposal           | `cognia-tech-proposal` (cite the ledger as its evidence base) |
| record an architecture decision                   | `domain-modeling` / ADR under `docs/content/docs/en/adr/`    |
| reproduce and diagnose a defect                   | `mattpocock-skills:diagnosing-bugs`                          |
| throwaway spike                                   | `mattpocock-skills:prototype`, or a separate `git worktree`  |
| adversarial check of one decision                 | `doubt-driven` with the ledger claims as the contract        |
| pre-commit audit + gates                          | `preflight` (pass it the ledger path)                        |
| real shell / device evidence                      | `tauri-smoke`, `run`, `cognia-e2e`                           |

## Anti-patterns

- Building the user's proposed fix before checking the observation it's
  supposed to fix.
- A single hypothesis "investigated" by collecting evidence that fits it.
- A single complexity score; "medium" written where "unknown" is true.
- A risk list written only by the agent that designed the solution.
- Obligations written after the code, or relaxed after they failed.
- "Should pass", "verified" without scope, or a confidence percentage as evidence.
- Treating green tests as "the problem is solved" (verification ≠ validation).
- Dropping a blocked real-environment smoke instead of carrying it as residual.
- Running the Deep lane on a clear one-line change.
