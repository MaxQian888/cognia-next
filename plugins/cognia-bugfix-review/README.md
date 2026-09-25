# cognia-bugfix-review

Audit-only bugfix review for Cognia agents. Ported from aiden-plugins' `aiden-code-review` (the `aiden-bugfix-review` skill plus its `abr-isolated-worker` context-isolation subagent), with the platform-specific prompt-capture mechanism removed.

## What it does

1. The **`bugfix-review` skill** resolves the review input — the authoritative `## Original User Prompt` (the user's original bug report), an optional non-authoritative `## Main Agent Diagnosis And Fix Summary`, and a `## Diff Scope` — and delegates to the reviewer subagent exactly once. It never reviews the diff itself and never fixes findings.
2. The **`bugfix-reviewer` subagent** (runtime id `cognia-bugfix-review:bugfix-reviewer`) builds an explicit evidence chain from the original trigger through the changed code to the user-visible symptom, and issues one of three verdicts — `Fixed (per static evidence)` / `Not fixed (per static evidence)` / `Cannot confirm the fix` (or `从代码看已修复` / `从代码看未修复` / `暂无法确认是否修复` when the bug report is in Chinese). It writes in the language of the original bug report, saves the full report as a chat **artifact** (`artifact_create`), and returns only a short result to chat. When artifacts are unavailable it returns the full report in chat instead. It is read-only: it never writes report files — or anything else — into the reviewed repository (`Edit` / `Write` are disallowed for it).

## Install

This plugin is **not bundled** with the app — build it and install it into the desktop app. From the repository root (after `pnpm install`, which provides the `esbuild` the CLI runs):

```bash
# One-time: build the plugin-author CLI (or use a released `cognia` binary).
cargo install --locked --path crates/cognia-cli

# Compile src/index.ts to dist/index.js (the manifest's `main`) and pack
# plugins/cognia-bugfix-review/target/cognia/cognia-bugfix-review-0.1.0.zip
cognia plugin build --path plugins/cognia-bugfix-review

# Install into the running desktop app over the CLI bridge…
cognia plugin install plugins/cognia-bugfix-review/target/cognia/cognia-bugfix-review-0.1.0.zip
```

…or open the desktop app's **Plugins** panel, choose the local `.zip` install action, and pick that ZIP. `dist/` and `target/` are build output and are not checked in.

Then enable **Bugfix Review** on the Plugins page and turn a skill on for a conversation from the chat composer's skill picker (type `@skill:`).

## When to use / not use

- Use after a bugfix lands, to independently verify the change resolves the user's original report.
- Do not use for general code review, for fixing the findings, or mid-task — it is audit-only and deliberately cannot continue the bugfix.

## Platform support

`local-bundle` skills are read through the desktop filesystem bridge, so the plugin is desktop (`tauri`) only; it is marked `blocked` for browser and mobile runtimes.
