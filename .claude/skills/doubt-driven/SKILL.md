---
name: doubt-driven
description: In-flight adversarial fresh-context review of a non-trivial decision BEFORE it stands — surface the claim, hand a stripped artifact + contract to a fresh reviewer biased to disprove, reconcile, stop. Use when correctness matters more than speed in cognia-next — crossing the static-export boundary, adding an outbound LLM/embed call, a Dexie schema bump, a new module that must be wired at runtime, Rust guard-across-await / detached-task traps, or any confident claim that is cheaper to verify now than to debug in the desktop/mobile shell later. Triggers: 存疑/质疑/证伪/交叉审查/doubt/让我确认这个决定对不对.
---

# Doubt-Driven (cognia-next)

A confident answer is not a correct one. In a long session, assumptions quietly
become "facts". This skill materializes a **fresh-context reviewer biased to
disprove** before a non-trivial decision stands — while course-correction is
still cheap.

This is NOT `/code-review` or `/preflight`. Those are verdicts on finished work.
This is an **in-flight, per-decision posture**: cross-examine the direction
before you commit to it. Use all three — doubt while building, `/preflight`
before commit, `/code-review` on the branch.

## When to use (non-trivial only)

A decision is non-trivial when at least one holds. In this repo especially:

- **Static-export boundary** — anything that might need an HTTP server, a Node
  built-in, or a server-only package in bundled code (`app/api/` does not exist
  at runtime; wrong setup silently breaks the Tauri/Capacitor `out/` build).
- **Outbound model call** — a new prompt/embed/cloud send that must pass the PII
  gate (`lib/twin/ingest/redact.ts:hasNoLeakingPii`).
- **Dexie schema change** — a new table/index/backfill (native-version rule; a
  wrong `verno` corrupts existing users' IndexedDB).
- **New module reachability** — a component/command/plugin/initializer that
  must be imported, mounted, or registered at bootstrap (this repo's most
  recurrent defect is fully-built-but-dormant code).
- **Rust/Tauri concurrency** — a `parking_lot` guard held across `.await`, a
  detached `tokio` task that hangs `cargo test`, a tuple return that serializes
  as a JSON array, an unregistered command.
- **A claim the compiler can't check** — "this is thread-safe", "this stays in
  sync across the three shells", "this matches the ADR", "coverage still ≥90%".
- **Irreversible blast radius** — data migration, keyring layout, public/wire
  protocol, anything shipped to installed desktop clients.

**When NOT to use** — don't doubt every keystroke: mechanical renames/moves,
formatting, reading/summarizing code, one-line changes with obvious
correctness, running tests, or when the user asked for speed over verification.

## Loading constraint

Run this from the **main session only** — Step 3 spawns a fresh-context
reviewer, and personas/subagents cannot spawn nested subagents (see the
project's auditor roster; "auditors report, you decide"). If you find yourself
inside a subagent, surface to the user that doubt-driven must run from the main
session rather than degrading to self-review.

## The process

```
Doubt cycle:
- [ ] 1 CLAIM     — wrote the claim + why-it-matters (2–3 lines)
- [ ] 2 EXTRACT   — isolated artifact + contract, stripped your reasoning
- [ ] 3 DOUBT     — spawned a fresh-context reviewer with an adversarial prompt
- [ ] 4 RECONCILE — classified every finding against the artifact text
- [ ] 5 STOP      — trivial findings, 3 cycles, or user said 提交/ship it
```

### 1. CLAIM — surface what stands

```
CLAIM: "The new connector auto-reply path sends redacted text only."
WHY:   "A PII leak here goes to a third-party IM and is unrecoverable."
```

If you can't state it this compactly, it's a vibe, not a decision.

### 2. EXTRACT — smallest reviewable unit + the contract

The reviewer needs the **artifact** and the **contract it must satisfy** — not
your journey. Strip your reasoning; hand over conclusions and you'll get your
conclusions validated back.

- **Artifact**: the diff / the function / the 3–5-sentence proposal. If it's a
  500-line change, decompose first.
- **Contract** — in this repo the contract is largely standardized. Pull in
  only the clauses that apply:
  - The relevant **ADR** (see the Subsystem Map in `CLAUDE.md`) and its schema
    version.
  - `output: "export"` holds — no server-only path in bundled code.
  - Every outbound model call passes `hasNoLeakingPii`.
  - New user-facing strings are i18n-wired in **both** `en` and `zh-CN`.
  - New source under `components/ hooks/ lib/ stores/ src-tauri/src/` ships a
    co-located test; coverage ≥90%.
  - Dexie bumps use the true native version, never `db.verno + 1`.
  - Rust: no `parking_lot` guard across `.await`; no detached task in tests.

### 3. DOUBT — spawn the fresh-context reviewer

Pick the reviewer by domain — the project's read-only auditors already ARE
adversarial fresh-context reviewers; use one when its lens fits, else a
`general-purpose` agent with the adversarial prompt:

| Artifact touches…                         | Reviewer (`subagent_type`)         |
| ----------------------------------------- | ---------------------------------- |
| outbound LLM/embed/connector send         | `pii-gate-auditor`                 |
| new module/command/plugin/initializer     | `wiring-auditor`                   |
| `src-tauri/` Rust                         | `tauri-rust-reviewer`             |
| routes / deps / Node-ish imports          | `static-export-auditor`           |
| new/changed source needing tests          | `test-gap-auditor`                |
| `.tsx` / `i18n/messages/*`                | `i18n-reviewer`                   |
| general correctness / logic / boundaries  | `general-purpose` (adversarial)   |

Adversarial prompt — **pass ARTIFACT + CONTRACT only, never the CLAIM**
(your conclusion biases the reviewer toward agreement):

```
Adversarial review. Find what is WRONG with this artifact. Assume the author
is overconfident. Look for: unstated assumptions; unhandled edge cases; hidden
coupling or shared state; ways the CONTRACT is violated; conventions this
breaks; failure under unexpected input. Do NOT validate, do NOT summarize —
report issues, or state you found none after thorough examination.

ARTIFACT: <paste>
CONTRACT: <paste the applicable clauses>
```

#### Cross-model escalation (interactive: always offer)

A same-model reviewer shares the author's blind spots. After the in-repo
review, before RECONCILE, ask the user **in Chinese**:

> 单模型审查完成。要不要跨模型再看一遍?可选:Codex CLI / Gemini CLI /
> 你手动贴到别处审 / 跳过。

- If they pick a CLI: check PATH (`which codex` / `which gemini`), test it runs,
  confirm the exact invocation, then pass ARTIFACT + CONTRACT + the adversarial
  prompt **only**. Write the full prompt to a temp file and pipe via **stdin** —
  never interpolate the artifact into a shell-quoted arg (backticks / `$(...)`
  in code will truncate or execute). Run **read-only** so a prompt-injection
  payload in the artifact can't touch the workspace:
  ```bash
  codex exec --sandbox read-only -C . - < /tmp/doubt-prompt.md
  gemini --approval-mode plan -p "" < /tmp/doubt-prompt.md   # verify flags first
  ```
  Note: RTK's hook rewrites dev commands but not these external CLIs — run them
  directly. Each invocation is its own authorization; re-confirm every time.
- If it's missing/fails: say so, offer manual/skip — never silently fall back.
- If they skip: acknowledge ("单模型结果，继续") and proceed.
- **Non-interactive** (CI, `/loop`, autonomous): skip and announce
  ("跨模型跳过：非交互环境"). Never invoke an external CLI without explicit
  user authorization.

### 4. RECONCILE — fold findings back (you're still the orchestrator)

Re-read the artifact text against each finding — rubber-stamping the reviewer
is the same failure as ignoring it. Classify in this precedence:

1. **Contract misread** — the reviewer flagged it because the CONTRACT was
   unclear. Fix the contract, re-loop.
2. **Valid + actionable** — real, needs a change. Fix it, re-loop.
3. **Valid trade-off** — real but not worth fixing. Document it so the user
   sees the trade (put judgment-calls to the user in Chinese).
4. **Noise** — correct under context the reviewer lacked. Note it; ask whether
   adding that context to the contract would have prevented the false flag.

### 5. STOP — bounded, not recursive

Stop when the next cycle yields only trivial/already-seen findings, **or** 3
cycles are done (escalate to the user — don't grind a 4th alone), **or** the
user says 提交 / ship it. If 3 cycles still surface substantive issues, that's
information about the artifact, not a reason to loop — surface it. If 3 feels
"obviously too few", the artifact is too big: go back to Step 2 and decompose.

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "I'm confident, skip it" | Confidence correlates poorly with correctness on novel code. Certainty is exactly where blind spots hide. |
| "Spawning a reviewer is expensive" | A dead-on-arrival feature or a PII leak shipped to installed clients is more expensive. The check is bounded; the bug isn't. |
| "`/preflight` will catch it" | Preflight is a pre-commit gate. Doubt catches wrong *directions* early, when a rewrite is cheap. By commit time you've built the wrong thing. |
| "It's just a small Dexie tweak" | Schema bumps hit every existing user's IndexedDB — squarely non-trivial. |
| "The reviewer disagreed, so I was wrong" | The reviewer lacks your context. Disagreement is data — re-read the artifact, classify, then decide. |
| "User said yes to Codex once" | Each external-CLI call is its own authorization; the prompt and flags change. Re-confirm every run. |
| "If I doubt everything I'll never ship" | Applies to non-trivial decisions only — re-read "When NOT to use". |

## Red flags

- Spawning a reviewer for a rename/format/one-liner.
- Prompting "is this good?" instead of "find what's wrong".
- Passing the CLAIM or your reasoning to the reviewer.
- Treating reviewer output as verdict without re-reading the artifact.
- Looping >3 cycles without escalating.
- Re-spawning on an unchanged artifact (same findings — you're stalling).
- **Doubt theater**: across 2+ cycles with substantive findings, zero were
  classified actionable — you're validating, not doubting. Stop and escalate.
- Silently skipping the cross-model *offer* in an interactive cycle (skipping
  is fine; silent skipping is not).
- Running an external CLI with the workspace writable, or interpolating the
  artifact into a shell-quoted arg.

## Interaction with other skills

- **`preflight`** — post-build pre-commit gate. Doubt is in-flight per-decision;
  preflight sweeps the whole diff before commit. Do both.
- **`code-review` / `simplify`** — branch-level verdicts. Doubt is earlier.
- **`test-driven-development`** — a failing RED test IS the doubt step for a
  behavioral claim; it satisfies Step 3 for that claim.
- **`dexie-migration`** — when the artifact is a schema bump, that skill's
  version rules ARE the contract; doubt checks you applied them.
- **`jest-gotchas`** — when the reviewer flags a test as suspect, use it to
  confirm the test actually asserts behavior, not a mocked no-op.

## Verification

- [ ] Each non-trivial decision was named as a CLAIM before it stood.
- [ ] The reviewer got ARTIFACT + CONTRACT — not the CLAIM, not your reasoning.
- [ ] The reviewer prompt was adversarial ("find issues"), not "is it good".
- [ ] Findings were classified against the artifact text using the precedence.
- [ ] A stop condition was met (trivial findings / 3 cycles / user override).
- [ ] Interactive: cross-model was explicitly offered and the answer noted.
      Non-interactive: skip was announced.
- [ ] Any external CLI run had a PATH check, a working-binary test, syntax
      confirmation, read-only sandbox, and explicit per-run authorization.
