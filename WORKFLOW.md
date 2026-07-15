# WORKFLOW.md

The condensed pipeline for turning an idea into merged, gated code in cognia-next.

It **orchestrates** the skills, sub-agents, and gates that already exist in this
repo and in your Claude Code install — it does **not** invent new tooling and it
does **not** restate the hard rules. The five hard rules in
[`CLAUDE.md`](./CLAUDE.md) (research-before-reuse, no simplifications,
co-located tests, i18n parity, EN narration / 中文提问) still govern **every**
step below. Read CLAUDE.md first; this file tells you _what to run when_.

Skills are invoked with the `Skill` tool (or `/name`); sub-agents with the
`Agent` tool. Names in `code` below are real, installed skills/agents.

---

## The pipeline (canonical, full-feature path)

| #   | Stage                          | Enter when…                             | Reuse (skill / agent / gate)                                                                                                             | Output                                                              |
| --- | ------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0   | Concurrency check              | another agent may share the tree/branch | `concurrent-tree-safety`                                                                                                                 | a safe stage/commit/branch strategy                                 |
| 1   | Understand & reuse             | before any new code                     | `Explore` / the `analyze-*` agents; grep `lib/ components/ hooks/ src-tauri/`; the ADR + Subsystem Map in CLAUDE.md; `context7` for libs | proof that no equivalent exists (Hard Rule 1)                       |
| 2   | Brainstorm                     | any "let's build X"                     | `superpowers:brainstorming`                                                                                                              | design spec → `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` |
| 3   | **Grill (design stress-test)** | spec drafted, **before** planning       | `grill-me` / `grilling`; use `grill-with-docs` (runs `domain-modeling`) when the design deserves an ADR + glossary                       | converged spec, plus ADR → `docs/content/docs/en/adr/` and glossary |
| 4   | Plan                           | spec has survived the grill             | `superpowers:writing-plans`                                                                                                              | a reviewable implementation plan                                    |
| 5   | Build (test-first)             | executing the plan                      | `superpowers:executing-plans` + `superpowers:test-driven-development`; domain skills (see map below); `jest-gotchas` before any test     | code **plus** its co-located test (Hard Rule 3)                     |
| 6   | Verify behavior                | code compiles                           | `verify` / `run`; `tauri-smoke` (desktop); `agent-browser` / Playwright / chrome-devtools MCP (web E2E)                                  | evidence the flow actually works, not just that tests pass          |
| 7   | Preflight audit                | before claiming "done"                  | `preflight` — fans out the 6 auditors in parallel                                                                                        | one severity-ranked findings list; fix blockers                     |
| 8   | Deterministic gates            | audits fixed                            | the gate commands below                                                                                                                  | gate output pasted **verbatim** (no "should pass")                  |
| 9   | Finish                         | gates green                             | `superpowers:finishing-a-development-branch`; `commit-commands:commit` / `commit-push-pr`                                                | merge / PR (Conventional Commits; never `--no-verify`)              |

---

## Task tiers — what to skip

Not every change earns the full 0–9. Pick the lightest lane that fits:

- **Trivial** (string/config tweak, one-line fix): skip 2–4, go straight to
  **5 → 7 → 8 → 9**. Still needs a test and passing gates.
- **Bugfix**: replace 2–3 with `superpowers:systematic-debugging` (diagnose
  before you touch a fix), then **5 → 6 → 7 → 8 → 9**.
- **Docs only** (subsystem / ADR docs): use `subsystem-docs`; the gate is
  `rtk pnpm docs:build` (the only thing that catches MDX prerender errors).
- **Schema change** (IndexedDB): route stage 5 through `dexie-migration`.
- **Visual workflow node**: route stage 5 through `workflow-node`.
- **Full feature / new subsystem / architecture decision**: run all of 0–9,
  and reach for `grill-with-docs` at stage 3 so the decision gets an ADR.

When unsure, over-run rather than under-run: a clean "nothing to do" is cheap.

---

## The grill gate (stage 3 — this repo's design stress-test)

Grilling is the checkpoint between _brainstorm_ and _plan_. Skipping it is how
unexamined assumptions become rework.

- **Trigger**: the moment a spec draft exists and you're tempted to start
  planning/coding. Grill first.
- **Which variant**:
  - `grill-me` / `grilling` — a relentless one-question-at-a-time interview to
    converge the design. Default choice.
  - `grill-with-docs` — same interview, but runs `domain-modeling` alongside so
    the session emits an **ADR + glossary**. Use when the design is worth
    keeping: architecture decisions, a new subsystem, or a schema bump.
- **Map the output to this repo's conventions**:
  - ADRs land in `docs/content/docs/en/adr/`, using the next free sequential
    number — `ls` the directory and take max + 1 (don't trust CLAUDE.md's
    Subsystem Map for the latest number; it lags behind the directory).
  - The design spec stays in `docs/superpowers/specs/`.
  - The glossary folds into the relevant ADR or spec — don't start a new
    top-level doc for it.
- **Fold the hard rules into the interview**: the grill must walk the five
  CLAUDE.md hard rules as design questions — _what existing code does this
  reuse? where do the co-located tests go? which en/zh-CN keys does it add?_ —
  so they're settled in the design, not discovered at the gate. Reference
  CLAUDE.md; don't restate it.

---

## Tooling to reach for (don't reinvent)

**Research / understanding** — `Explore`, the six `analyze-*` agents
(frontend, ai-infra, rust-core, plugins-workflows, infra-devops,
testing-quality), `context7` (library docs), `deepwiki` (repo Q&A),
`find-skills` (discover a skill for a sub-task).

**Domain skills for stage 5** — `ai-sdk`, `ai-elements`, `streamdown` (chat/AI
surfaces); `dexie-migration` (schema); `workflow-node` (visual workflows);
`jest-gotchas` (before writing any test); `tauri-smoke` (desktop bring-up);
`concurrent-tree-safety` (shared trees).

**Preflight auditors (stage 7)** — `test-gap-auditor`, `i18n-reviewer`,
`static-export-auditor`, `tauri-rust-reviewer`, `pii-gate-auditor`,
`wiring-auditor`. `preflight` dispatches whichever the diff triggers.

**Cross-cutting reuse gates (from CLAUDE.md)** — before writing an outbound
LLM/embed path, route it through `packages/redact/src/index.ts:hasNoLeakingPii`;
before adding a server-only dep, update `next.config.ts` (static-export
caveat). The Subsystem Map + Cross-cutting hooks table in CLAUDE.md is the
first place to look for something to reuse.

---

## Gates (deterministic — run before claiming "done", stage 8)

Audits don't replace the real gates. Run these and paste the output verbatim:

```bash
rtk tsc && rtk pnpm lint && rtk pnpm lint:i18n && pnpm i18n:sort:check
rtk pnpm test -- <changed test files>                  # narrow first
pnpm test:coverage                                     # full gate when claiming done (≥90%)
rtk cargo test --manifest-path src-tauri/Cargo.toml    # if src-tauri/ changed
rtk pnpm docs:build                                    # if docs/ changed
```

Baselines are known-broken on `dev` (tsc, `eslint .`, i18n sort, rust
dead-code warnings). Gate on **"no NEW errors on the files you touched"**, not
on a clean repo-wide sweep — the husky `lint-staged` hook only blocks a commit
when a **changed** file has errors.

`/preflight` is the fast way to run stage 7 + surface the exact gate commands
for the current diff.
