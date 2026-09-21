---
name: bugfix-review
description: Use to review whether bugfix changes resolve the user's reported issue or fix request. Audit-only — it delegates to an isolated reviewer subagent, returns its verdict, and stops. Do not use to fix code, to continue an in-progress bugfix task, or for general code review.
allowed-tools: Bash, Read, Task, dispatch_agent
---

Delegate the review to the `cognia-bugfix-review:bugfix-reviewer` subagent. Do not perform the review directly.

This skill is audit-only: resolve the review input, delegate once, return the subagent result, then stop. Do not fix findings, ask whether to fix them, or continue the bugfix task.

Resolve `Original User Prompt` before delegating: use the explicit `## Original User Prompt` section from the input, verbatim. If it is absent, say so in the delegation input rather than inventing one — never infer it from the main-agent summary.

Pass the resolved input to the subagent without rewriting or filling gaps. If no diff scope is provided, use `Current workspace changes.` Expected input:

```md
## Original User Prompt

The user's original bug report or fix request.

## Main Agent Diagnosis And Fix Summary

Optional non-authoritative summary of how the main agent understood, investigated, diagnosed, and fixed the bug.

## Diff Scope

Current workspace diff, commit, commit range, or a provided diff.
```

`Original User Prompt` is authoritative. `Main Agent Diagnosis And Fix Summary` is optional context only and must not narrow, expand, or replace it.

The reviewer subagent writes the full report to the artifacts directory and returns a short user-visible result. Return that result to the user without adding fixes or follow-up actions. A successful result looks like:

```md
Bugfix review completed.

结论: <从代码看已修复 / 从代码看未修复 / 暂无法确认是否修复 + short explanation>

Report: <timestamped absolute path>
```

If the subagent reports artifact write failure, return that failure directly. Do not write missing reports yourself, invent conclusions, repair code, or include runtime metadata or token/tool stats in chat.
