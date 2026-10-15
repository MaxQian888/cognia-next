---
name: codex-agent
description: Delegate a scoped task to Codex CLI as a controlled subagent — a second-opinion or adversarial code review, a read-only investigation, or a scoped implementation written straight into this working tree with every change attributed. Use when a fresh model should check work, when a bounded fix or feature can be handed off, or when the user asks to "让 Codex 做 / 给 Codex 审 / codex review". Not for current web facts (use codex-web-search).
argument-hint: <implement|review|research> <task>
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/codex-agent.mjs *)
---

# Codex as a subagent

`${CLAUDE_SKILL_DIR}/scripts/codex-agent.mjs` supervises one `codex exec` run
per job. It owns the sandbox, timeouts, retries, schema-checked output, and
working-tree attribution. Call it directly; never hand-roll `codex exec`.

## Modes

| Mode        | Sandbox                                  | Use for                                       |
| ----------- | ---------------------------------------- | --------------------------------------------- |
| `review`    | read-only                                | second opinion on a diff; `--adversarial` to attack a design |
| `research`  | read-only (`--search` adds live web)     | root-cause hunts, "how does X work", impact analysis |
| `implement` | workspace-write, **main working tree**   | a bounded change confined to `--scope` paths  |

In `workspace-write`, `.git` is read-only and there is no network, so Codex
cannot stash, reset, checkout, or commit. It can still overwrite any file,
which is why implement mode snapshots every uncommitted and ignored file
(caches and build output excepted), backs them up, and attributes every
change afterwards.

## Running a job

Always give the task on stdin with a quoted heredoc, and always run it with
the Bash tool's `run_in_background: true`. Codex runs take minutes; the
harness notifies you when the runner exits. For review with no extra focus,
pass `</dev/null`.

```bash
${CLAUDE_SKILL_DIR}/scripts/codex-agent.mjs run --mode implement \
  --scope lib/foo/ --scope components/foo/foo-card.tsx \
  --verify "pnpm test -- lib/foo/bar.test.ts" <<'CODEX_TASK'
<self-contained task: goal, constraints, files to read first, done criteria>
CODEX_TASK
```

```bash
${CLAUDE_SKILL_DIR}/scripts/codex-agent.mjs run --mode review --adversarial \
  --scope lib/foo/ <<'CODEX_TASK'
Focus: retry and cancellation paths.
CODEX_TASK
```

Review targets: `--scope <paths>` (uncommitted changes there), `--base <ref>`
(commits since ref), or `--commit <sha>`. Never review "all uncommitted
changes": the tree is shared.

Options: `--effort none|minimal|low|medium|high|xhigh` (review defaults to
medium, others use the user's Codex config), `--model`, `--timeout-ms`,
`--idle-timeout-ms`, `--allow-dirty`, `--keep-mcp`. Leave model and effort
unset unless the user asks or the task clearly needs more.

Other commands: `status [<job>]`, `result <job>`, `cancel <job>`,
`resume <job>` (follow-up on the same thread, delta on stdin),
`restore <job> <path>...` (undo an out-of-scope change of that job; takes the
writer slot, refuses if the file changed again, never writes through a
symlink).

## Writing the task

Codex starts with no memory of this conversation and already reads AGENTS.md.
The runner wraps your text in the repo rules and output contract; you supply:

- The goal and the done criteria, in one task per job.
- Context Codex cannot infer: the decision already made, files to read first,
  the ADR, constraints from the user.
- For implement: the narrowest `--scope` that fits (files or directories, not
  the repo root), including the co-located test files, and `--verify` commands
  that prove the change (single test files, `cargo test -p <crate> <filter>`).

Do not paste large diffs or files; name the paths and let Codex read them.

## Control limits the runner enforces

- One implement job at a time per repository; at most two read-only jobs.
  Slots are lock files that stay held while the runner or any process of its
  Codex group is alive; a crashed runner's leftover processes are killed by
  the next invocation before its slot is reused.
- Implement refuses when a scope path already has uncommitted changes the job
  chain did not make (another session's work). Ask the user before
  `--allow-dirty`.
- Wall-clock timeout scales with effort (low 5 min, medium 15, high 30,
  xhigh 45); the idle watchdog stops a run with no events for 10 minutes
  (tripled while a command is executing). Both kill the whole Codex process
  group.
- One automatic retry, only for a transient failure before any file changed.
- At most two resumes per thread; a third needs `--force`, after asking the
  user.

## Handling the result

The runner prints one JSON object: `status`, `result` (schema-checked),
`attribution` (implement), `error`, `next`, `job_dir`. Exit codes: 0
succeeded, 1 failed, 2 usage, 3 refused, 4 timed out, 5 needs attention,
130 cancelled.

Codex's answer is a claim. Accept it only after your own checks:

1. **implement**
   - Read `git diff -- <attribution.changed_in_scope>` yourself.
   - Rerun every `result.verification` command yourself; trust only your run.
   - `attribution.out_of_scope` lists files that changed outside the scope
     during the run. `codex_evidence: true` means a Codex command named the
     path; otherwise another session may have made it. Inspect, then
     `restore` only what Codex did.
     `ignored: true` marks a gitignored file (an env file, local settings).
   - `claimed_not_changed` / `changed_not_claimed` mean the report and the
     tree disagree: find out why before accepting.
   - `unprotected` lists ignored directories too large to snapshot; changes
     there would go unseen, so mention them if the task could touch them.
   - `result.status` of `partial` or `blocked` is reported to the user, not
     silently finished by you.
   - Commit through the normal path (`/preflight`, `git commit --only
     <paths>`); Codex never commits.
2. **review**: verify each finding against the code before calling it real;
   drop findings you cannot reproduce. Do not apply fixes unless the user
   asked for them.
3. **research**: treat `inferred` findings as hypotheses; spot-check the
   `observed` evidence that your next decision depends on.

Failures: report `status`, `error`, and `job_dir` to the user. Do not quietly
redo a failed Codex task yourself. For `timed_out` or `idle_timeout`, inspect
`events.jsonl` in the job directory before resuming or retrying with a
narrower task.

For a risky change, do not let the worker grade itself: follow an implement
job with a `review` job (or a Claude reviewer subagent) on the same paths.
