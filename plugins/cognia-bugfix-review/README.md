# cognia-bugfix-review

Audit-only bugfix review for Cognia agents. Ported from aiden-plugins' `aiden-code-review` (the `aiden-bugfix-review` skill plus its `abr-isolated-worker` context-isolation subagent), with the platform-specific prompt-capture mechanism removed.

## What it does

1. The **`bugfix-review` skill** resolves the review input — the authoritative `## Original User Prompt` (the user's original bug report), an optional non-authoritative `## Main Agent Diagnosis And Fix Summary`, and a `## Diff Scope` — and delegates to the reviewer subagent exactly once. It never reviews the diff itself and never fixes findings.
2. The **`bugfix-reviewer` subagent** (runtime id `cognia-bugfix-review:bugfix-reviewer`) builds an explicit evidence chain from the original trigger through the changed code to the user-visible symptom, and issues one of three verdicts: `从代码看已修复` / `从代码看未修复` / `暂无法确认是否修复`. It writes the full Chinese-first Markdown report to `bugfix-review-YYYYMMDD-HHMMSS.md` + `bugfix-review-latest.md` under the task's artifacts directory (`artifacts/` at the workspace root by default) and returns only a short result to chat.

## When to use / not use

- Use after a bugfix lands, to independently verify the change resolves the user's original report.
- Do not use for general code review, for fixing the findings, or mid-task — it is audit-only and deliberately cannot continue the bugfix.

## Platform support

`local-bundle` skills are read through the desktop filesystem bridge, so the plugin is desktop (`tauri`) only; it is marked `blocked` for browser and mobile runtimes.
