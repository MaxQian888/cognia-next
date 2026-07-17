---
name: preflight
description: Audit a Cognia change before commit or completion. Use for preflight, 提交前检查, or final verification; scopes the diff, runs the applicable test-gap, i18n, static-export, Tauri/Rust, PII, and wiring auditors, synthesizes findings, and executes deterministic gates.
---

# Preflight (parallel audit fan-out)

Orchestrates the project's six read-only auditors over the current change,
then reports one prioritized list. Auditors report; YOU decide and fix.

## 1. Scope the diff

Determine what's being shipped:

- Uncommitted work: `rtk git status` + `rtk git diff --name-only HEAD`
- A branch: identify the actual base with `rtk git merge-base HEAD <base>`,
  then run `rtk git diff --name-only <merge-base>...HEAD`. Do not infer the base
  from a stale branch convention.

Record the file list — it decides which auditors run.

## 2. Dispatch applicable auditors in parallel

Pass each agent the same scope statement: the base ref to diff against and
the file list. Skip an auditor only when its trigger set is empty:

| Auditor (subagent_type)  | Run when the diff touches…                                  |
| ------------------------ | ----------------------------------------------------------- |
| `test-gap-auditor`       | anything under `components/ hooks/ lib/ stores/ src-tauri/` |
| `i18n-reviewer`          | any `.tsx` or `i18n/messages/*.json`                        |
| `static-export-auditor`  | `app/`, `next.config.ts`, `package.json` deps, or new Node-ish imports in bundled code |
| `tauri-rust-reviewer`    | anything under `src-tauri/`                                  |
| `pii-gate-auditor`       | `lib/Codex/ lib/ai/ lib/connectors/ lib/twin/ lib/memory/ lib/vector/ sidecar/` or any new outbound call |
| `wiring-auditor`         | any NEW module/component/command/plugin/initializer/setting — verifies it is reachable at runtime |

When unsure whether an auditor applies, run it — a clean "no findings" is
cheap; a missed finding is not.

## 3. Synthesize

Merge the reports into one list ordered by severity:

1. **Blockers** — would fail a gate or break production (missing test on a
   gated path, PII bypass, dead `app/api/` route, unregistered command)
2. **Should-fix** — stale tests, missing zh-CN keys, hard-coded strings
3. **Needs decision** — anything an auditor flagged as judgment-call; put
   these to the user in Chinese, don't resolve silently

Deduplicate cross-auditor overlaps (e.g. a new file flagged by both test-gap
and i18n). Fix blockers before proceeding unless the user says otherwise.

## 4. Deterministic gates (after fixes, before commit)

Audits don't replace the real gates. Finish with:

```bash
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm lint:i18n
rtk pnpm i18n:sort:check
rtk pnpm test -- <changed-test-files>
rtk pnpm test:coverage
rtk cargo test --manifest-path src-tauri/Cargo.toml # when src-tauri changed
```

Report gate output verbatim — no "should pass".
