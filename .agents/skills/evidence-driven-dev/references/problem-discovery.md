# Problem discovery

Goal: turn the user's words into a **problem model** that is honest about what
is observed, what is guessed, and what is wanted. It is not an attempt to
"find the true requirement" behind the user's back. The output is the Knowledge
table, the Problem frame, and the user's confirmation of the goal (G items).

## 1. Decompose the request

Users describe problems from limited experience. They mix five kinds of
statements in one sentence. Pull them apart before anything else:

| Layer             | Example ("Agent long runs keep dying, add auto-retry") | Ledger entry     | Your stance                                      |
| ----------------- | ------------------------------------------------------ | ---------------- | ------------------------------------------------ |
| Observation       | long runs stop                                         | O (if confirmed) | Find the actual record: when, which runs, how often |
| Cause guess       | "probably network / flaky execution"                   | H                | Keep as one hypothesis among several             |
| Proposed solution | auto-retry                                             | candidate, in D  | A candidate, not the answer                      |
| Underlying goal   | long tasks complete reliably                           | G (Proposed)     | Confirm with the user                            |
| Value boundary    | don't lose progress, don't repeat side effects         | C                | These become hard constraints                    |

A request containing only an observation and a goal is already a problem
statement: record it and move on. A request with a **cause guess or a named
solution** is the case this stage exists for. The risk is that the guess sets
the architecture.

## 2. Classify each open question

| Type   | Example                                       | Who resolves it              |
| ------ | --------------------------------------------- | ---------------------------- |
| Fact   | Why did the run terminate?                    | You: investigate, don't ask  |
| Causal | Would retry raise the completion rate?        | An experiment or comparison  |
| Value  | Does the user prefer speed or reliability?    | The user, and only the user  |

Facts are your job. Never ask the user something the logs, code or git history
can answer. Value questions are theirs. AI can lay out the trade, but must not
pick the value for them. Causal questions usually become a spike or experiment
(see `complexity-discovery.md`).

## 3. Competing hypotheses

When the request carries a cause guess, write **at least two** H items before
investigating. Include the boring ones (e.g. "the user cannot tell it is still
running" for a "too slow" complaint). Then look for **discriminating evidence**:
an observation that would come out differently under H1 than under H2. Evidence
that fits every hypothesis is not worth collecting first.

Update states as evidence arrives: Hypothesized → Verified / Contested /
Invalidated. Don't delete invalidated hypotheses. They are the record of why the
frame changed, and `ledger.mjs check` uses them to flag stale conclusions.

## 4. Where evidence lives in this repo

Prefer things that actually happened over opinions about what might happen:

- **Code and history**: the owning module (Subsystem Map in `CLAUDE.md`), its
  ADR under `docs/content/docs/en/adr/`, `git log -p -- <paths>`,
  `git log --oneline -i --grep=fix -- <paths>` (how this area broke before),
  `git blame` on the suspicious lines.
- **Prior design work**: `docs/superpowers/specs/`, `docs/plans/`, an existing
  evidence ledger in `docs/evidence/` for the same area.
- **Runtime evidence**: reproduce it. Use the `run` skill, `tauri-smoke` for the
  desktop shell, Playwright / `cognia-e2e` for flows, and
  `mattpocock-skills:diagnosing-bugs` for a disciplined repro loop. App
  diagnostics live behind `lib/diagnostic-service/` / `components/logging/`;
  crash and diagnostic submission behind `crates/cognia-observability/`.
- **Past incidents**: the user's memory directory (cross-session notes on what
  broke, what is still pending, which environments are hard to reach).
- **Outside knowledge**: `context7` for library behavior, `codex-web-search` for
  current external facts. Cite what you used in the Basis column.

Read access is not write access. Anything that touches the user's real data,
accounts, devices or external services needs their go-ahead.

## 5. When the frame is good enough

Stop discovering when **one** of these holds:

- The remaining hypotheses all lead to the **same next action**, so further
  discrimination would not change what you do.
- A cheap discriminating test exists. Then the next action is that test (a
  `diagnose` or `spike` decision), not more analysis.
- The open questions are value questions. Put them to the user.

Then write the **Problem frame**: the problem chosen for now, the outcome that
would show it is solved (seed an M row in Outcome now, not at the end), and
what is explicitly out of frame.

## 6. Talking to the user

Present the model, not a questionnaire. Ask in Chinese (repo rule) and keep it
short:

- 我们观察到了什么 (O items, with sources)
- 目前有哪些可能的解释 (H items, and what would distinguish them)
- 什么还不清楚 (Q / Unknown)
- 建议下一步做什么 (the cheapest discriminating action)
- 需要你确认的决定 (the G items and any value questions)

If their proposed solution still looks right after investigation, say so and
build it. The point is to check the request, not to argue with it. If
investigation points elsewhere (e.g. compaction loses the plan, so retry would
not help), show the evidence and let them choose.

## 7. Hand-offs

- The frame is a product flow with actors, branches and exceptions →
  `map-requirement-flow` (Build mode, code-aware) to make it behaviorally
  complete.
- The frame needs design convergence with the user → `grilling`, seeded with
  the Knowledge table so it does not re-ask settled facts.
- The frame is a defect → `mattpocock-skills:diagnosing-bugs`. Its repro and
  minimization results are O/H evidence.
