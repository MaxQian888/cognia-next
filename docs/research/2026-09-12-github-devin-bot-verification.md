# GitHub Devin Bot implementation and verification

Date: 2026-09-12

Target repository: `NJUPT-SAST/sast-approval-next` (editable installation setting).

## Delivery status

The installable plugin, Desktop execution, and Headless execution support are implemented. This is **not yet a complete production acceptance** of the approved plan. An isolated Headless host and Brain have been rebuilt, started, and used to install/configure the plugin through the real host RPCs. That fixture has no Cognia GitHub integration account, and the installation correctly remains `needs_setup`. Monitoring has therefore **not been armed**. GitHub publication and its resulting CI still require a real generated result approved through the application.

Package: `plugins/github-devin-bot/github-devin-bot.zip` (SHA-256 `ccb9adb1fe4caf2b59b79ecb6d858cfb423306f3132963b68e13063929d014da`). Build/install details are in the plugin README. The package depends on the updated host APIs and the updated `github-delivery` plugin in this checkout; installing it into an older Cognia binary does not install those host changes.

## Implemented path

1. The builtin plugin catalog and distribution loader discover `github-devin-bot`. Its Bot declaration supplies the repository/model configuration, credential slot, manual backfill form, polling and GitHub event triggers, and execution policy.
2. Existing Bot installation/detail screens reuse `AdapterForm`, credential selectors, run/delivery lists, and trigger controls. Paired lifecycle commands and host console reads use the existing authenticated control bridge. The first arming stores an activation watermark; a prior manual scan cannot move it backward. Backfill requires explicit item numbers.
3. `ctx.bots` reads owned installation state, records synchronization health, enqueues stable work identities into the existing delivery table, and cancels obsolete resource work. Optional structured trigger conditions filter repository, branch, labels, actor, draft state, and CI conclusion before model dispatch.
4. Run-bound integration calls resolve the GitHub account on the host. Ownership, plugin dependency, installation binding, repository scope, and action allowlists are checked. Existing account-based calls remain owner-scoped. GitHub Delivery supplies paginated reads, checks, workflow jobs/logs, and lifecycle normalization.
5. Shared workspace/Git APIs allocate a checkout per Bot run. Headless discovers its admitted physical workspace root through `fs_workspace_roots` and uses the existing confined filesystem/Git operations; paired clients retain their opaque-path restrictions. Shared external-agent management dispatches an isolated Devin ACP process using an explicitly confirmed SWE-2 model. Host checkpoints record the workspace, session, dispatch identity, result, and immutable publication snapshot.
6. The existing decision interrupt holds the exact patch, test report, model/session, target SHA, and review/PR text. Run Detail uses the existing source-control diff viewer and authoritative host run-detail reads for paired clients. Parked approvals release the repository execution slot and retain their original seven-day deadline.
7. Publication is host-brokered. It revalidates approval, workspace snapshot, target revision, generated branch identity, and remote state. Git objects and publication identities are checkpointed; uncertain branch/PR results are reconciled before another write. There is no merge action.
8. Disabled installations stop new dispatch and abort active execution. Closed/superseded items cancel obsolete deliveries. Blocked results retain their snapshot and report for inspection instead of silently succeeding.

No separate scheduler, queue database, approval store, Bot dashboard, or Devin launcher was introduced.

## Mature Bot comparison

The following official documentation was checked on 2026-09-12. The implementation choices in the last column are Cognia design decisions, not claims of equivalent product coverage.

| Product                                                                                   | Documented pattern                                                                                                                                                                          | Applied here                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Probot](https://probot.github.io/docs/)                                                  | GitHub Apps combine granular permissions with webhook delivery. Its [fixture receiver](https://github.com/probot/probot/blob/master/docs/simulating-webhooks.md) supports event simulation. | Use the existing integration account and verified webhook ingress; normalize fixture and polling events through the same handler. Do not add an independent credential store.     |
| [Renovate](https://docs.renovatebot.com/configuration-options/)                           | Repository-scoped branch/PR limits and optional dashboard approval regulate update creation. The dashboard exposes pending, open, closed, and failed work.                                  | Bound repository execution; shared run/approval lists; distinguish deferred work from failures. Cognia approval additionally binds concrete patch content and publication intent. |
| [Mergify](https://docs.mergify.com/configuration/conditions/)                             | Rules evaluate PR attributes such as branches, labels, reviews, and CI. Check names can be qualified by publishing GitHub App to avoid ambiguity.                                           | Structured pre-dispatch conditions, explicit match/skip reasons, and current-revision CI checks. This plugin deliberately provides no merge action.                               |
| [CodeRabbit](https://docs.coderabbit.ai/configuration/auto-review)                        | Non-draft automatic reviews, incremental review after pushes, author exclusions, and optional auto-pause reduce repeated work.                                                              | Review only new heads, remember the last published review revision, exclude drafts/self-generated work, and preserve explicit backfill.                                           |
| [Devin Review and Auto-Fix](https://docs.devin.ai/use-cases/gallery/devin-review-autofix) | Repository/user enrollment triggers reviews on open, push, and ready-for-review events. Its documentation warns that responding to all Bot comments can create loops.                       | Stable revision identities and host provenance suppress recursion. Repairs are approved separate PRs targeting the original branch, rather than direct unsolicited edits to it.   |

This comparison supports keeping provider events, execution, approvals, and publication separate in the existing runtime. It does not justify broadening account access or treating model-reported tests as independently verified results.

## Verification evidence

The following evidence has distinct boundaries; fixture tests do not establish a running monitor or public publication.

| Check                                                  | Observed result                                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Core Bot, UI, DB, and API focused test run             | 64 suites / 819 tests passed before final audit fixes; subsequent focused regressions were rerun                                         |
| Queue fairness, recovery, shutdown, and approval tests | Latest core runtime run: 4 suites / 121 tests passed; all four covered files exceed 90% lines, branches, and functions                   |
| New root Bot APIs/ownership/conditions coverage        | 18 tests passed; 99.46% lines, 96.73% branches, 100% functions in the scoped run                                                         |
| Plugin monitor/execution fixture coverage              | Final 70-test run: 99.9% lines, 96.1% branches, 100% functions, including external check failures and uncertain recovery                 |
| External agent/workspace APIs                          | New core modules reached at least 90% lines/branches/functions in scoped coverage; isolation and recovery tests passed                   |
| Shared integration/contract checks                     | Focused integration, binding, validation, bridge, run-control, and run-detail tests passed; final publication audit run: 44 tests passed |
| Run Detail and approval controls                       | 45 tests passed for immutable result inspection and exact inspected-run approval controls                                                |
| Rust launcher                                          | 6 tests passed; launcher binary built successfully                                                                                       |
| Rust external sandbox and spawn policy                 | 21 sandbox tests and 26 spawn-policy tests passed                                                                                        |
| Rust Devin MCP config                                  | 7 tests passed                                                                                                                           |
| Workspace file metadata                                | 24 TS tests and 2 Rust tests passed                                                                                                      |
| Contract/author declarations                           | Contract freshness and 80 bundled author declarations passed                                                                             |
| English/Chinese localization                           | Split-source generation, freshness, and i18n lint passed                                                                                 |
| Static-export import audit                             | 8,619 TypeScript files audited; no Node-only import violations                                                                           |

The final paired lifecycle/UI/bridge verification covered 324 tests across the expanded focused suites, including mirror-write denial, host-switch invalidation, scope validation, and explicit read-error states. The new lifecycle host boundary reached 100% lines/functions and 97.26% branches in its focused coverage run (`/tmp/github-bot-lifecycle-host-coverage.log`). The new paired-host read hook passed 17 tests with 100% statements/lines/branches/functions, covering stale responses, pairing changes, malformed payloads, recovery, and unmount cleanup.

### Real Devin ACP smoke

The existing harness ran with an isolated fixture and the task-built launcher:

```sh
COGNIA_DEVIN_BOT_ISOLATION_SMOKE=1 \
COGNIA_EXTERNAL_AGENT_LAUNCHER=target/debug/cognia-external-agent-launcher \
node scripts/smoke/build-and-run-smoke.mjs --devin-acp
```

Passed: authenticated `swe-2-medium`, native fixture file reads/writes, separate concurrent MCP configurations, sibling session close, session listing/loading/reconnection, follow-up continuity, and cancellation acknowledgement. A synthetic credential fixture was inaccessible outside the allowed workspace; GitHub/SSH credentials were removed from the child environment. No public GitHub write was part of this smoke.

Local evidence log: `/tmp/github-bot-devin-isolation-smoke.log` (temporary, not committed).

### GitHub and UI evidence

Read-only GitHub API inspection confirmed that the target is public, unarchived, and uses `master`. The current `gh` identity has read/write access. There were 19 open issue/PR items and recent successful workflows at inspection time. This **does not** mean Cognia has a configured integration account: the isolated Cognia fixture has no integration account, and its new Bot installation remains `needs_setup`.

A real browser loaded the reused Bot page and installation surface. It correctly displayed that the standalone browser cannot run Bots without a paired host. Real Headless RPC acceptance subsequently verified plugin activation, executable catalog discovery, installation, duplicate-request reconciliation, model configuration round trips, disable/re-enable, and `needs_setup` with automatic triggers unarmed. The complete visual paired installation, approval, retry, and disable flow has **not** been driven end to end in a running desktop/paired application. Temporary screenshots: `/tmp/github-bot-ui.png`, `/tmp/github-bot-setup-blocked.png`.

The isolated fixture installation is `boti_0c5d9be6-2f29-41bc-9732-65631b8a652d`, definition `github-devin-bot:repository-monitor`. Its saved configuration is the target repository, `swe-2-medium`, 30 minutes, and two repair attempts. The `github` slot is unbound. Poll and GitHub event triggers remain unarmed; enabled manual entrypoints do not represent active monitoring. This is a development-host installation, not an installation into an already running production desktop profile. After acceptance, the task-owned temporary host was stopped and port 27917 was confirmed closed; its data, checkouts, installation, and audit records remain under `/tmp/cognia-github-bot-host`.

Live evidence: `/tmp/github-bot-headless-installation-final.log` (repeated after the final CLI rebuild and restart), `/tmp/github-bot-headless-installation-live.log`, `/tmp/github-bot-headless-installation-receipt.json`, and `/tmp/github-bot-headless-workspace-live.log`. The workspace log retains the initial failures followed by post-fix 200 results. The native server and CLI builds passed, and the generated companion contract check passed with 697 commands and 101 routes. Explicit JSON-null success responses now survive both the Headless bridge decoder and the desktop command boundary; malformed missing responses still fail.

No public test issue, comment, review, branch, or PR was created.

## Open acceptance boundaries

- **Headless execution:** owned workspace provisioning and service-only physical Git routing are implemented. Native host/Brain bootstrap and live filesystem/Git primitives were exercised. The rebuilt host passed fresh guarded clone, exact-SHA fetch/checkout, recovery of an existing checkout, and snapshot Git reads against the target repository. The live clone-output and refspec-input contract regressions are fixed and retested. Full paired UI execution remains a separate acceptance boundary.
- **Uncertain external turns:** sessions are persisted and reconnected, but the provider interface cannot authoritatively query a durable completed turn by dispatch identity. Such a turn is retained as an actionable blocked result; it is not automatically resubmitted. Automatic recovery to a completed result is not established.
- **Test evidence:** commands and exit codes in the plugin report are explicitly agent-reported. Tool events and the patch are available for inspection; this is not independent host execution of every reported command.
- **Production activation:** an updated Cognia Desktop or Headless host, an enabled GitHub Delivery account bound to the installation, and Devin readiness are needed before monitoring can be armed. Missing setup must remain visible.
- **Publication acceptance:** after an actual result is approved, verify the remote branch commit, exact PR/review contents, target branch, and resulting CI independently. That acceptance has not occurred.

## Repository-wide gates

The shared checkout contains hundreds of concurrent changes. Scoped lint and tests passed, but the global gates are not green:

- The actual 16 GiB `pnpm typecheck` reported existing errors across unrelated skills, teams, gateway, and plugin code. Task-specific errors found during the run were fixed. RTK's filtered typecheck output was insufficient; the raw script output is the source of truth.
- `plugin:author-imports` reports six existing violations in the VS Code template activation test and `kimi-subscription` tests.
- Full lint exhausted its heap while scanning the large shared tree/cache artifacts.
- Full repository coverage encountered unrelated failing suites and was stopped after disk exhaustion. A global coverage result was not obtained. The final four-file core runtime coverage exceeds 90% per file; this and other scoped coverage must not be presented as a global pass.
- The full Next production build was not run after the disk repeatedly reached ENOSPC. The static-export source audit is a separate, narrower passing check.
- The newly added Rust companion run-detail RPC test was not executed within the available disk budget.
- The initial Git fetch-refspec Rust fixture compile hit ENOSPC. The later native server build compiled the updated Git code. A local bare-Git fixture verified exact-SHA retrieval for a commit available only through a PR ref; live Headless exact-SHA fetch and checkout subsequently returned 200 and preserved the requested HEAD.

Only task-generated development output and the incremental caches of crates compiled for this task were removed to recover space. The smoke-tested launcher executable and concurrent source edits were retained. No commit or push was performed.

## Rollback

Disable the Bot installation and its triggers through the existing Bot controls. This stops new dispatch and cancels active execution while preserving run records, approval snapshots, and publication history. Do not delete those records to roll back an installation. Already-published GitHub artifacts require separate deliberate handling.
