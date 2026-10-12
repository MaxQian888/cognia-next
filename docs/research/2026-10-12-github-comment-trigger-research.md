# GitHub comment-triggered agents: current Cognia support

Date: 2026-10-12 (Asia/Shanghai)

Scope: inspect the current Cognia checkout and compare its GitHub mechanisms with `anthropics/claude-code-action`. This is research, not an implementation or deployment. Checkout: `dev`, HEAD `8fd9377fc01b17c2dfa9900008bc92ffcce35f34`, with pre-existing uncommitted changes. Findings describe inspected source, not a verified configuration of a running Cognia installation.

## Finding

Cognia already supports **GitHub comment events as inputs to generic workflows and Bots**, with GitHub API actions for replies and publication. It does **not currently provide a ready-made `@cognia <request>` comment-command agent comparable to `claude-code-action`**, nor a repository Actions workflow that starts one on a comment.

Three existing mechanisms must be distinguished:

| Mechanism                     | What exists                                                                                                 | Boundary                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GitHub Delivery v3            | Verified webhook ingress, issue/PR comment events, workflow/Bot routing, Inbox projection, API reads/writes | Requires enabled plugin, credentials, ingress configuration, and an execution host; no dedicated mention-command handler |
| GitHub Devin Bot              | Event/poll-driven issue implementation, PR review, CI repair, configurable execution/publication decisions  | Its declared event types do not include comments; executor is specifically Devin                                         |
| GitHub Actions temporary Host | Local desktop dispatches an Actions job that provisions a paired Cognia Host                                | `workflow_dispatch` only; provisions infrastructure, does not process comment instructions                               |

Sources: [GitHub Delivery implementation](../../plugins/github-delivery/src/index.ts), [manifest and host compatibility](../../plugins/github-delivery/plugin.json), [Devin Bot triggers](../../plugins/github-devin-bot/src/index.ts), [temporary-host workflow](../../deploy/github-runner/cognia-runner.yml).

## 1. What already works in source

### Comments are declared and normalized

GitHub Delivery declares `issue_comment.created`, `.edited`, `.deleted`, `pull_request_review_comment.created`, `.edited`, `.deleted`, and `pull_request_review.submitted`. `normalizeGithub` retains the original payload, actor, account, repository identity, and delivery ID. Issue comments and PR conversation comments use `issue_comment`; inline diff comments use `pull_request_review_comment`. GitHub's own event documentation makes the same distinction.

Sources: [event declarations and normalizer](../../plugins/github-delivery/src/index.ts#L909), [GitHub event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment).

### The event route is wired

The inspected path is:

```text
GitHub App webhook / PAT repository webhook
  → public ingress URL
  → Rust verification + durable spool
  → integration:delivery-available
  → drainIntegrationIngress
  → normalizeGithub
  → publishIntegrationEvent
      → trigger.integration.event → matching workflows
      → dispatchIntegrationEventToBots → armed matching Bots
      → Inbox projection
      → issue-board refresh for relevant issue events
```

The Rust receiver verifies the configured HMAC signature and queues the delivery before returning HTTP 202; duplicate queued deliveries return HTTP 200. The TypeScript publisher also deduplicates the event and uses a delivery-derived workflow occurrence key. Ingress has acknowledgement, retry/dead-letter inspection and replay paths. These are existing mechanisms to reuse, not a reason to add another webhook receiver.

Sources: [Rust ingress receiver](../../crates/cognia-scheduling/src/workflow/triggers/webhook_router.rs#L483), [ingress client](../../lib/integrations/ingress-client.ts), [event publication](../../lib/integrations/events.ts), [Bot event adapter](../../lib/bot/sources/integration-event.ts).

Desktop boot mounts the Integration runtime through deferred initializers. Headless imports and registers the same runtime for the brain host. The ingress client accepts `tauri` and `headless`; standalone browser/mobile clients do not host this receiver. A public HTTPS URL and an online host remain deployment requirements.

Sources: [deferred boot](../../components/providers/initializers/deferred-boot-initializers.tsx), [Integration boot](../../components/providers/initializers/integration-boot-initializers.tsx), [headless registration](../../lib/headless/runtimes/integration-runtime.ts), [headless imports](../../lib/headless/runtimes/index.ts), [public URL checks](../../lib/integrations/github-repo-webhook.ts).

### Workflow/Bot filtering is available, but mention matching is not supplied

The workflow inspector exposes plugin, integration, account, event type, resource kind, and repository ID filters. For example, a workflow can target plugin `github-delivery`, integration `github`, event `issue_comment.created`, resource kind `repository`, and resource ID `owner/repo`. This selects comment events; it does not itself select comments containing a command.

Generic Bot conditions support repository, branch, labels, actors, draft, conclusion, and equality/membership at an envelope path. They can restrict known actor logins or match exact payload values. They do not implement a GitHub mention parser or substring/regular-expression command matcher. Connector mention flags exist elsewhere, but the GitHub event adapter does not populate them.

Sources: [workflow configuration UI](../../components/workflow/editor/inspector/forms/trigger-forms.tsx#L288), [workflow matching](../../lib/workflow/runtime/trigger-subscriptions.ts#L388), [Bot matching](../../lib/bot/events/router.ts), [Bot conditions](../../lib/bot/events/conditions.ts), [GitHub-to-Bot adaptation](../../lib/bot/sources/integration-event.ts).

### Comment display and writeback exist

Created issue comments project `/comment/body` into the Inbox. PR conversation comments are aliased into the PR thread; inline comments and submitted reviews use their own body/URL fields in that thread. Edited/deleted comment events are declared, but the issue-comment Inbox projection only subscribes to `.created`; declarations alone do not establish a full edit/delete synchronization experience.

The plugin supplies `commentIssue`, `commentPr`, `reviewPr`, `reviewPrInline`, `openPr`, and `listIssueComments`. Generic writes become approval-waiting action jobs; Bot-bound writes use validated publication decisions. Existing action jobs include audit, retry and idempotency handling. These are writeback building blocks, not an already-assembled comment-agent conversation.

Sources: [Inbox projection definitions](../../plugins/github-delivery/src/index.ts#L1066), [projection runtime](../../lib/integrations/events.ts), [comment actions](../../plugins/github-delivery/src/index.ts#L450), [comment history read](../../plugins/github-delivery/src/index.ts#L645), [action queue and decisions](../../lib/integrations/action-runner.ts#L274).

### Issue-to-PR automation exists with a narrower contract

The host's `runGithubIssueLoop` fetches an issue, clones a workspace, invokes the agent, commits/pushes, and opens a PR, recording checkpoints. Its action schema takes repository, issue number, head/base, and optional PR title/body. The **agent prompt uses the fetched issue title/body**, not the triggering comment; optional `body` is used for the resulting PR description. Simply connecting a comment event to this action would not preserve the comment's requested task.

The action runner replaces the plugin's intentionally unavailable export with this host executor. Therefore that export is not evidence that the loop is wholly unimplemented. The availability gate nevertheless requires `isTauri()`: Headless can receive comments and run API actions, but cannot execute this particular loop.

Sources: [issue-loop implementation](../../lib/integrations/github-issue-loop.ts), [schema](../../plugins/github-delivery/src/index.ts#L898), [host executor replacement and availability](../../lib/integrations/action-runner.ts#L49), [plugin export](../../plugins/github-delivery/src/index.ts#L680).

## 2. Related automation is not comment-command support

GitHub Devin Bot watches new/closed issues, PR lifecycle events, completed checks and completed workflow runs. It also has polling and manual triggers. Its event list excludes both comment families. The handler routes monitoring events into repository work and then invokes a Devin ACP execution path. Adding a comment event to the list alone would not make its monitor understand the comment's instructions.

The Bot already reuses isolated workspaces, durable jobs, decisions, target-SHA checks and GitHub publication. Desktop and Headless are supported in its manifest; browser/mobile use a paired host. Both event and poll triggers default to disarmed. It is github.com-only; GitHub Delivery separately supports account-specific Enterprise API origins.

Sources: [Bot declaration](../../plugins/github-devin-bot/src/index.ts), [monitor](../../plugins/github-devin-bot/src/monitor.ts), [execution](../../plugins/github-devin-bot/src/execute.ts), [installation and behavior](../../plugins/github-devin-bot/README.md).

The repository also ships an Actions **temporary-host provisioner**. Its template accepts only `workflow_dispatch`, checks an actor allowlist, starts digest-pinned containers, and returns recipient-encrypted pairing artifacts. The desktop validates the installed template before dispatch. Reusing that template by casually adding `issue_comment` would change its input, pairing and provenance assumptions; it is not a drop-in comment-action runner.

Sources: [workflow](../../deploy/github-runner/cognia-runner.yml), [Action metadata](../../deploy/github-runner/action.yml), [provisioner contract](../../deploy/github-runner/README.md).

No `claude-code-action` invocation or comment-command workflow was found in the current `.github/workflows/` inventory. GitHub Delivery is bundled but explicitly manual-enable-only. Source availability does not mean a user's GitHub App, webhook or Bot is currently enabled.

Sources: [workflow directory](../../.github/workflows), [manual activation gate](../../lib/plugin/core/manager.ts#L96), [bundled catalog](../../lib/plugin/core/browser-builtin-assets.generated.json).

## 3. Comparison with Claude Code Action

The reference implements a repository-installed Actions workflow: GitHub event → trigger and actor validation → checkout/context preparation → Claude execution → comment/branch output. Its official example listens for comment/review and issue events and uses `@claude`. Explicit `prompt` also supports unattended workflow tasks. This is a different deployment model from Cognia's host-owned Integration runtime.

Two comparison details matter: explicit-prompt mode does not automatically gather interactive comment context or create a tracking comment; those must be configured, or supported entity events can use `track_progress`. Also, the default issue flow supplies commits and a prefilled Create a PR link, rather than guaranteeing automatic PR creation. Its current parser has a finite event whitelist, so broad documentation language about any GitHub event is not proof of arbitrary-event support.

See the [primary-source reference investigation](../reports/github-comment-trigger-research-2026-10-12/reference-action.md) for the pinned source revision, exact trigger logic, permissions, execution and output limitations.

| Capability                              | Claude Code Action                                      | Current Cognia                                                                                   |
| --------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Issue and PR conversation comments      | Built-in interactive trigger                            | Event foundation exists                                                                          |
| Inline PR comments/review text          | Supported event/context path                            | Events and projections exist; no command handler                                                 |
| `@agent` request parsing                | Default `@claude`, configurable phrase                  | No ready-made GitHub mention-command parser found                                                |
| Commenter authorization                 | Checks repository actor permissions, explicit overrides | Static actor conditions exist; no dedicated dynamic commenter permission check on a command path |
| Task context                            | Fetches thread/repository context for execution         | Raw event preserved, history API exists; no assembled command-context contract                   |
| Execution                               | Actions runner with Claude                              | Workflow/Bot host; Devin-specific Bot, desktop-only generic issue loop                           |
| Progress/final reply                    | Integrated comment output                               | Comment action exists; command lifecycle output is missing                                       |
| Durable control/approval                | Actions job and configured permissions                  | Existing host-owned Bot/action queues, decisions and audit                                       |
| One-step repository Action installation | Published `anthropics/claude-code-action@v1`            | No equivalent comment-task Action found; temporary-host template serves another purpose          |

Sources: [official example](https://github.com/anthropics/claude-code-action/blob/main/examples/claude.yml), [Action inputs](https://github.com/anthropics/claude-code-action/blob/main/action.yml), [permission implementation](https://github.com/anthropics/claude-code-action/blob/main/src/github/validation/permissions.ts), and Cognia sources above.

HMAC verifies GitHub delivery authenticity; it does not mean every person who can comment is authorized to spend model credits or publish code. GitHub sender metadata is external provenance, not an authenticated Cognia principal. A future command handler must make this decision explicitly rather than treating the receipt of a signed webhook as approval.

Sources: [Rust signature gate](../../crates/cognia-scheduling/src/workflow/triggers/webhook_router.rs#L509), [external actor adaptation](../../lib/bot/sources/integration-event.ts), [reference permission model](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md).

## 4. Recommended implementation direction

This is a research recommendation, not an implemented feature.

For Cognia-hosted execution, extend the existing Integration → Bot route with a GitHub comment-command handler. Reuse GitHub Delivery for ingress and API calls, the Bot control plane for queue/run state, and shared workspace, execution and publication decisions. A separate command handler can coexist with Devin's repository monitor; reusing its primitives does not require forcing every comment task through its existing monitor or Devin-specific model contract.

The task contract should carry repository/account, issue-or-PR kind/number, comment ID and revision, requested command, actor, relevant thread context and target SHA. Explicitly define mention grammar, permitted actors, bot/self-output suppression, edit/retry behavior, per-thread concurrency, cancellation, fork publication, and progress/final/failure replies. Where code is changed, publication should retain the existing decision and stale-head checks.

If the desired product instead is “install YAML in any repository and invoke Cognia without an already-running host,” a dedicated Actions task entry point is additional work. It needs trusted checkout/event validation, execution/model credential bootstrap, bounded task lifetime and result output. The temporary-host provisioner supplies useful container/lifecycle building blocks but does not supply this task contract. Both entry points should converge on shared command execution semantics rather than grow two independent agent systems.

Possible acceptance example: an authorized maintainer posts `@cognia fix <request>`; one job receives the exact comment instructions, records the base SHA, reports acceptance, runs in an isolated workspace, and publishes the approved result. Redelivery creates no second job; unauthorized or self-generated comments start no model work; stale/closed targets and failed verification prevent publication. Edited comments and fork PRs need separately defined acceptance cases.

## 5. Verification and limits

Executed on 2026-10-12:

```text
rtk pnpm exec jest --runInBand --coverage=false --runTestsByPath \
  plugins/github-delivery/src/index.test.ts \
  lib/integrations/events.test.ts \
  lib/integrations/ingress-client.test.ts \
  lib/integrations/action-runner.test.ts \
  lib/integrations/github-issue-loop.test.ts \
  lib/bot/events/conditions.test.ts \
  lib/bot/sources/integration-event.test.ts \
  plugins/github-devin-bot/src/index.test.ts

Test Suites: 8 passed, 8 total
Tests:       133 passed, 133 total
```

These focused tests support source-level normalization, routing, projection, condition and action behavior. They do not verify a public webhook, a live GitHub comment-to-agent execution, a newly deployed Action, current credentials, model execution, or current production enablement. Rust receiver behavior was inspected, not tested in this pass. No coverage run, implementation, GitHub writes, commit or deployment was performed.

The existing [2026-09-12 Devin verification report](2026-09-12-github-devin-bot-verification.md) records historical live issue-to-PR execution. It supports the distinction between repository automation and the absent comment-command path, but is not evidence of current service health.

ADR-0018 explicitly labels much of its original delivery UI/connector design as historical. Current source and manifest were used for this report; old Settings pages, removed GitHub templates and former policy-gate descriptions should not be treated as current product capabilities.

Sources: [ADR-0018 current shipping boundary](../content/docs/en/adr/0018-github-delivery.md).
