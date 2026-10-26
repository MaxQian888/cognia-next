---
title: "0239 — An outbound action is authorized by the request, not by the tool"
description: "Agents can send to third parties through about ten paths, each with its own gate or none, and nothing records who a send was meant for or who asked for it. Builds the Action Review policy engine the contract already reserved: an outbound action needs an authorized recipient. The thread the request came from is implicitly authorized; any other recipient needs an explicit grant (this once, for this instruction, or a person-configured policy). A human denial fences the same send until the requester gives a new instruction, and an unattended run never sends to an unauthorized recipient."
---

# ADR 0239 — An outbound action is authorized by the request, not by the tool

**Status:** Accepted (phases 1, 2a and 2b implemented, each in shadow mode by default)
**Date:** 2026-10-24
**Related:** [ADR-0070](./0070-risk-ceremony-policy-layer) (risk → ceremony; the origin-thread precedent), [ADR-0169](./0169-one-runtime-one-review-one-control-machine) (one review contract), [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched) (per-run capability grants), [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings) (unattended runs on a Host)
**Corrects:** the Action Review contract header, which cites ADR-0102 (an observability decision) and a policy engine that was never built

## Context

### What exists

Cognia already has most of the parts of an authorization system:

- **The Action Review contract** (`packages/agent-config-types/src/action-review.ts`) defines a request, a decision and a durable receipt, plus 15 channels. Its `ActionReviewAuthority` deliberately has no `"model"` member: a model can only fill `recommendation`, which the contract says the policy engine "copies onto the request and never reads".
- **Receipts** (`lib/db/action-review-receipts.ts`) are kept for 90 days and capped at 20,000 rows. Chat tools, the seven Squad gates and workflow steps write them.
- **Deterministic rules**: a per-tool `allow | ask | deny` ruleset with explicit deny winning, command safety, and the ADR-0070 risk classifier, whose `external-send` surface is rated high.
- **Unattended handling**: scheduled, Bot and plugin turns carry a `permissionProfile` (ADR-0198). Their tool approvals park for 30 minutes and are pushed to a phone (`lib/claude/unattended-park.ts`), and a run that is never answered ends `needs_approval`.
- **Connector safeguards**: write-tier HITL cards default on (`lib/connectors/permission-resolve.ts`), a draft queue exists (`runtime.ts` `createDraft`), and a PII gate runs on every automated delivery (`lib/connectors/delivery-gateway.ts`).
- **Denial memory**: `lib/claude/permissions/session-denials.ts` turns a human Deny into an explicit deny rule for the rest of the session.

### What is missing

**The policy engine was never built.** The contract header names `lib/policy/action-review/policy.ts` and a `planActionReview` function. Neither exists. Each producer resolves its own verdict and records a receipt after the fact, and only some do: no producer writes `connector-tool`, `connector-workflow`, `github-delivery`, `thread-handoff` or `generic`, and `bot-step` only looks up its adapter.

**Nothing knows who a send is for.** An agent can reach a third party through about ten paths, each with its own gate or none:

| Path | Gate today |
| --- | --- |
| IM auto-mode reply (`lib/connectors/runtime.ts`, `source: "ai-run"`) | PII gate only |
| Scheduled digest, `/schedule`, external-bridge `connectors_send_message` (`lib/connectors/scheduled-outbound.ts`) | None on send. The digest turn passes **no permission responder**, so its approvals go unanswered until they time out |
| `im.broadcast` (up to 20 targets), `im.create_chat`, `im.dispatch_task` | Write-tier HITL card |
| Plugin `ctx.connectors.enqueueSend` (`source: "plugin"`) | Per-call card in IM turns |
| Workflow `action.connector.send` | Node risk gate, only when the workflow sets `riskGating` |
| Bot delivery | The connector path |
| Built-in and MCP tools such as `send_email` | The ordinary `ask` ladder; MCP annotations are not trusted |
| GitHub writes through the integration broker: PR, issue, comment, review (chat tools, workflow nodes, plugins, Bots) | A write needs a repository-scoped capability grant or a person's approval in the integration queue. A Bot write needs an approved `bot_approval` interrupt, which a Bot set to publish automatically passes by policy when its installation allows unapproved writes. Nothing checks the repository against the request |
| Squad stacked delivery (`POST /pulls` when a run completes); `gh pr create`, `gh api -X POST` and other `gh` writes in a shell | None: `gh` is classified as a safe command |
| Browser click, key press and form fill | The ordinary ladder. No path knows whether an action submits |

No outbound recipient allowlist exists anywhere: every "allowlist" in the code governs inbound triggers, and the `/schedule` allowlist governs who may schedule, not who receives. An outbound job records a `source` but not the person who asked for it.

**A ruleset allow authorizes every recipient.** "Allow always" on a send tool, or a tool in `alwaysAllowTools`, lets every later call through, to anyone.

**Denials do not hold.** Session denials are in renderer memory, so a reload loses them. They are keyed on the command or path, which a send tool does not have, so one refusal becomes a tool-name deny for the whole session. They apply from the next send, not the running turn. Subagents run on their own session id and never see them. Only a human Deny in the main chat is recorded; auto-mode denials, timeouts, ACP answers, teammate asks and unattended parks are not. `clearSessionDenials` has no production caller. Nothing ties a refusal to the instruction it answered, so "do not send" lasts exactly as long as the model remembers it.

**Auto-mode cannot help.** It judges shell commands only, and its judge receives the command, the working directory and the reply language, never the user's request. That is the right design for a command-safety judge, and it means auto-mode has nothing to say about where a message goes.

### The precedent

ADR-0070 rejected treating an IM-bound run as `external-send`: a team summoned from a thread replying **into that same thread** is the feature working, because the recipient is the person who asked. The real risk is "reaching a recipient the requester did not ask for". This ADR makes that sentence enforceable.

## Decision

### One engine, in the slot the contract reserved

`lib/policy/action-review/policy.ts` exports `planActionReview(request, context)`. It is pure and deterministic, and it returns a plan: `allow`, `ask`, `draft`, `park` or `deny`, with the authority and the grant that justify it. Producers call it before they act, not after. It reads ruleset verdicts, grants and fence entries from its context; it copies `recommendation` and never reads it. Every outcome is written as an `ActionReviewReceipt` through the existing writers.

Phase 1 consults the engine for **outbound actions** only. Other tool approvals keep their current path unchanged.

### Outbound actions and their targets

An action is **outbound** when it would deliver content to a party other than the user:

- a connector delivery from any automated source (`ai-run`, `skill`, `plugin`, `workflow`, `notification`, Bot delivery). `manual` and `draft-approved` are a person's own act and are not reviewed again;
- a tool call whose tool is classed outbound. There is one list (`lib/policy/risk/outbound-tools.ts`) with one name normalization, read by the risk classifier and this engine. The classifier's `external-send` set stays the narrower part of it: the IM built-in skills, `team_post_to_chat` and `connectors_send_message` are reviewed here but not yet counted as risk, because counting them changes plan gating for every team that can use them. A test pins that gap. Sends to the user's own sessions or teammates (`send_session_message`, `team_send_message`) are not outbound.

Every outbound action carries a **target**: the channel (connector adapter, mail, or tool family) and a normalized recipient id (conversation key, user id, address). A producer that cannot name the target gets `ask` interactively and `draft` or `park` unattended, never `allow`.

### Who is authorized

`planActionReview` decides in this order. The first match wins.

1. **Fence or explicit deny → `deny`.** A deny rule still beats everything, as it does today. A fence hit (below) is a deny with authority `policy-deny`.
2. **The origin thread → `allow`.** The conversation the current instruction came from is implicitly authorized: the desktop or paired-device session the user typed in, or the IM thread where the requester spoke. Authority `policy-default`.
3. **A grant → `allow`.** Authority `human` for a card grant and `policy-rule` for a configured one. A grant has one of three scopes:
   - `once`: this single action, from the approval card;
   - `instruction`: this recipient on this channel until the instruction epoch advances, from the approval card;
   - `policy`: a recipient list a person configured on a Bot installation or a connector channel policy. Only a person can write it. An agent, a plugin or a model cannot.
4. **Otherwise:** interactive → `ask`, with the recipient shown on the card. Unattended → `draft` for a connector delivery (the existing draft queue, approved by a person) and `park` for a tool call (the existing unattended park and phone push). An unattended run never sends to an unauthorized recipient.

Two consequences follow:

- **A ruleset `allow` no longer authorizes a recipient.** For an outbound tool it means only "this tool may be used". The recipient still needs step 2 or 3. An explicit `deny` keeps its full force.
- **No session-wide "always allow" for outbound actions.** The card hides the button, as it already does for `requiresPerCallApproval` tools. Durable authorization is a person-authored `policy` grant.

To keep this decidable, outbound tools always reach the renderer: the sidecar treats the `outbound` class as always-ask with or without a `permissionProfile` (today it applies only with one). The engine then allows silently when step 2 or 3 matches, so the origin-thread case shows no card.

### A model can only narrow

A model's view of the request can make a plan stricter, never looser. For example, it can turn an allow into an ask because the user said "draft, don't send". It can never turn an ask into an allow. Phase 1 ships the deterministic order above. Model narrowing is phase 3 and lands only through `recommendation`.

### The instruction epoch

Every outbound review carries the **instruction epoch** of its root session: the id of the latest message from the requester. It advances when:

- the user sends a message from the desktop or a paired device;
- in IM, the original requester sends a new message in the thread;
- in a shared session, the member whose request the run serves sends a new message;
- for a run that has no conversation (a scheduled task, a Bot trigger), a person edits the task or installation, or writes in its session.

It does **not** advance on a scheduled or Bot trigger, a webhook, the model's own follow-up, a subagent's or teammate's message, or a message from anyone else in an IM group or shared session. Nor does it advance on a user-role row an automation wrote: another session's agent, a background task's result, the project coordinator, a workflow, a plugin, a verifier, an external runtime or an imported transcript. Those producers mark their rows `metadata.automatedTurn`, because such a row is otherwise shaped exactly like one the person typed. Only a person's edit advances a task's or Bot's revision; an agent's or plugin's edit does not.

### The denial fence

A **human deny** on an outbound review creates a fence entry. While the root session's epoch stays the same, any outbound action with the same **fingerprint** is denied without asking. That covers another tool, a reworded message, or a subagent or teammate of the same root.

- **Fingerprint**: `outbound | channel | normalized recipient`. The message body is excluded, so rewording does not get around the fence. A different recipient is evaluated afresh.
- **Root session**: subagents, teammates and background children map to their root through the existing approval routes (`lib/claude/agents/subagent-approval-routes.ts`, `lib/chat/approval-routing.ts`).
- **Storage**: the fence is not a new store. It is derived from deny receipts, so it survives a reload and needs no second source of truth. Receipts gain optional fields (contract version 1, additive): `subject.targets`, `origin.rootSessionId`, `origin.instructionEpoch`, `request.plan` and `decision.grant`. A target is stored as its channel and fingerprint only. The recipient itself (a conversation key, a platform user id, an address) is personal data, the receipt table is classed metadata-only, and the scheduled tasks that hold the same targets are encrypted for exactly that reason. One multiEntry index, `*authKeys` (`deny|root|epoch|fingerprint` and `grant|…`), serves both the fence and instruction grants; Dexie cannot put a multiEntry field in a compound index. It was added in schema v249. An in-memory cache serves lookups.
- **Not a fence**: a timeout or expiry is not a refusal. It denies that action only, and the next attempt asks again (the existing doom-loop guard still caps repeats). A model's opinion never fences.
- **Lifetime**: until the epoch advances, bounded by receipt retention. The dormant `pruneActionReviewReceipts` now runs in the central retention sweeper, and the row cap never trims a receipt that carries a fence or a grant.

`session-denials.ts` keeps handling non-outbound tools. Outbound denials go to the fence instead.

### Two chokepoints

- **Tool calls**: the desktop permission handler (`hooks/chat/claude-chat-events.ts`), the unattended responder (`lib/claude/unattended-permission-responder.ts`) and the teammate path (`lib/chat/room/runner.ts`) call `planActionReview` for outbound tools before they show a card or auto-answer.
- **Connector deliveries**: `enqueueOutbound` plans every automated source before a job is created. An unauthorized unattended delivery becomes a draft. A delivery that already carries a tool-call grant is not asked twice: the job carries the receipt id that authorized it.

### Who asked

An outbound job records `authorizedBy`: the receipt id, the requester actor and the grant scope. That answers "who authorized this message" from the job alone, and it is what a later recipient-visible attribution (the mail connector in the [roadmap](../../../../plans/2026-10-24-grok-gap-roadmap.md)) will read.

### Repairs folded in

- The digest turn in `scheduled-outbound.ts` gets the same unattended responder as other scheduled turns, so its approvals park instead of going unanswered.
- The contract header cites this ADR instead of ADR-0102, `registry.ts` stops claiming nine channels (there are 15), and the stale `lib/ai/agent/agent-team-runtime.ts` path is corrected.

### Phase 2: GitHub writes and browser submissions

Phase 2 extends the same engine to two more kinds of recipient. It only narrows: when the engine allows a GitHub write, the gates that exist today (the sidecar card, capability grants, the integration approval queue, `bot_approval`) still apply. The engine changes an outcome only to hold an unattended write to an unauthorized recipient, to refuse a fenced one, or to ask in chat before writing somewhere other than the origin thread.

- **A repository is the GitHub recipient.** A write targets `github:<host>/<owner>/<repo>`. The PR or issue it writes to is a thread: a write back into the thread the request came from (a Bot mentioned on PR #12 answering on PR #12) is a reply to the origin thread. A list entry, a grant or a fence covers the whole repository. People mentioned in a body and assignees are not reviewed as recipients.
- **Covered paths**: every write action of the integration broker (chat tools, workflow nodes, plugin code, Bots), non-GET raw authenticated requests (such as Issue Loop's `POST /pulls`), Squad stacked delivery, and `gh` write subcommands in a shell, whose repository comes from `-R`, the API path or the working directory's remote and is unknown otherwise. `git push` keeps its existing ask: it supplies code, it does not address anyone. The GitHub MCP server's tools stay on the ordinary ladder, because their names and shapes are not ours to trust. Backups written to the user's own repository are not outbound.
- **Configured automation keeps working.** A repository-scoped capability grant, a Bot installation's repository scope with automatic publishing, and a Squad team's repository binding with stacked delivery on are each a `policy` grant for that repository: a person wrote them, naming it. New lists only a person writes: a Bot installation's list can hold repositories, and each GitHub integration account gets a repository list covering every unattended write through it.
- **An unauthorized unattended write waits.** Under enforcement it is held in the integration approval queue, even where a grant or a Bot binding would have queued it directly, and pushed to the user like a parked tool approval. A Squad publish waits for an "approve and publish" action.
- **A person's own click is the authorization.** Stack publish and land, issue publish and write-back, review delivery and thread PR buttons record a `human` receipt and keep their behaviour.
- **A browser recipient is a site**: the origin of the request a submission sends. The interactive request grants it with "allow for this request"; unattended runs use a global site list in Settings → Security, and a Bot's list can hold sites. Phase 2b starts by measuring, per engine, whether a submission can be detected or held before it leaves. On an engine with no reliable signal, an enforced click, key press or form fill on a site nobody authorized is treated as a possible submission.
- **Each category has its own switch.** Messaging (phase 1), GitHub and browser each start in shadow mode and are enforced only after a person confirms that category, so turning on enforcement for messages does not start enforcing GitHub or browser writes on upgrade.

## Phases

| Phase | Scope |
| --- | --- |
| 1 | The engine; the outbound list and targets; origin, grant and draft/park order; the instruction epoch; the fence with its receipt fields and index; both chokepoints; `authorizedBy`; the digest responder; hiding "always allow" for outbound tools; the doc corrections |
| 2a | GitHub writes: the integration broker, raw authenticated requests, Squad stacked delivery and `gh` write commands (plan: `docs/plans/2026-10-25-adr-0239-phase-2.md`) |
| 2b | Browser form submission, starting with a spike that establishes a submit signal per browser engine |
| 3 | Model narrowing through `recommendation` |

## Implementation (phase 1)

Phase 1 shipped in twelve work packages (plan: `docs/plans/2026-10-24-adr-0239-phase-1.md`). The engine runs in **shadow mode** by default: every outbound tool call and connector delivery is planned and the plan recorded on its receipt (`plan.enforced: false`), and no send changes. A person turns on enforcement in Settings → Security (`agentPermissions.outboundAuthorization: "enforce"`), after reviewing what it would change.

### Where it lives

- **Engine**: `lib/policy/action-review/policy.ts` (`planActionReview`, `readOutboundAuthorizationMode`) and `plan-context.ts` (origins for a session, a scheduled task `task:<id>`, a Bot `bot:<id>`, a workflow run; fence and instruction grants from receipt `authKeys`, schema v249).
- **Targets**: `lib/policy/risk/outbound-tools.ts` (the outbound tool list) and `lib/policy/action-review/outbound-targets.ts` (normalized targets and fingerprints).
- **Tool chokepoint**: `plan-tool-call.ts`, used by the desktop ask path, `run-and-capture.ts` for every headless capture, the scheduler executor and the CLI tool host. The sidecar always asks for outbound-classed tools.
- **Delivery chokepoint**: `plan-delivery.ts`, called by `enqueueGoverned` / `enqueueAuthorized` in `lib/connectors/delivery-gateway.ts`. Every job records `authorizedBy`. A tool's delivery is matched to the call through `authorized-tool-calls.ts`, an in-memory record of calls planned and allowed.
- **Policy grants**: `configured-grants.ts` reads three lists only a person writes: a connector instance's `outboundRecipients` (`adapter:<id>`, every unattended send through that account), a conversation's `proactivePush` opt-in, and a Bot installation's `outboundRecipients` (`bot:<id>`, only that installation's runs). They are edited in the connection settings and the Bot detail, through one editor.
- **Cards**: the desktop and phone approval cards name each recipient and offer "allow for this request" (the `instruction` scope). "Always allow" is hidden for outbound tools.
- **Shadow report and switch**: `shadow-report.ts` and `components/settings/security/outbound-authorization-card.tsx`.

### Decisions made while implementing

- **A receipt stores no recipient.** A target is persisted as its channel and fingerprint only (`ActionReviewTarget`), because the receipt table is metadata-only. Recipient names exist only on pending approvals in memory. The shadow report names recipients by matching fingerprints against what the device already holds: connector conversation states, bound sessions and the configured lists. A recipient it cannot match is counted, not named.
- **Lists store the recipient itself**, in the engine's normalized form, so a person can read back whom they allowed. Fingerprints are computed when planning.
- **Unattended runs are planned where their permission requests are answered** (`answerWithOutboundPolicy` in `run-and-capture.ts`), not inside each responder. The digest turn's approval parks like a scheduled task's when it fires on a schedule, asks in its conversation when a card click started it, and is refused at once from the external bridge.
- **Notification targets need no list.** Governed notification pushes write their jobs directly; a target set to proactive consent is already the person's grant (recorded as `policy-rule`), and an origin-reply target only carries approval requests.
- **`authorizedBy` has no requester yet.** The requester is inferred for the epoch but not stamped on connector jobs.

### Known gaps

- An approval made through the `/lark` slash-command path does not go through the host's `approveTool`, so a tool's delivery after it is planned as unattended.
- Under enforcement, an external-bridge digest that would need approval is drafted.
- On a shell driving a paired Host, the switch and the report are read-only notices: the setting and the receipts live on the Host, with no remote reader yet.
- Enforce mode has unit and integration coverage but no run on a real desktop and phone yet (an origin reply, a cross-group send, a parked approval answered on the phone, a Bot's scheduled delivery from draft to approved send).

## Implementation (phase 2a)

Phase 2a, GitHub writes, shipped in ten work packages (plan: `docs/plans/2026-10-25-adr-0239-phase-2.md`). It has its own switch and starts in **shadow mode**: every GitHub write is planned and recorded, and none changes, until a person turns it on in Settings → Security (`agentPermissions.outboundAuthorizationByCategory.github: "enforce"`). Enforcing messages does not enforce GitHub.

### Where it lives

- **Targets and categories**: `outbound-targets.ts` adds `repositoryTarget` (`github:<host>/<owner>/<repo>`, host defaulting to `github.com`; the PR or issue is an in-memory `thread` used only to match the origin thread), `siteTarget` for phase 2b, and `outboundCategoryOf`. `readOutboundAuthorizationMode(settings, category)` reads each category's mode; a plan is enforced when any of its targets' categories is.
- **What is a GitHub write**: `github-targets.ts` reads the integration registry (an integration `github`, or an operation `github.*`, that is not `read`) and takes the repository from the action's `scopeSelectors`. `gh` commands are classified by `packages/plugin-contract/src/lib/claude/permissions/gh-command.ts` (read, write or local; an unknown command is a write) and their repositories extracted by `gh-targets.ts` (`-R`, `GH_REPO`, a PR or issue URL, an API path, else the session checkout's `origin` remote, else `unknown`). `command-safety.ts` moved `gh` out of the safe heads: a write asks and is outbound, and auto mode's model judge cannot allow it.
- **Broker chokepoint**: `plan-integration.ts` (`planIntegrationWrite`) is called by `executeIntegrationAction` before a write job is queued and by `authenticatedIntegrationRequest` for every non-GET request (Issue Loop's `POST /pulls` included). Its receipts are `integration-action` subjects on the `github-delivery` channel, naming the requester (`plugin:<id>`, `bot:<id>`, `workflow:<id>`, `tool-call:<session>`, `agent-team:<id>`, `person:<surface>`) and the integration account. A held write is queued `awaiting_approval` with `outbound.held` and pushed through `lib/integrations/outbound-hold.ts`; only a person's approval releases it, and a person's cancel fences the repository.
- **Tool chokepoint**: `plan-tool-call.ts` plans GitHub write tools and shell calls with a `gh` write as outbound, in the GitHub category. The sidecar, the Agent SDK hooks and the CLI tool host apply the always-explicit rule to them through `SendOptions.alwaysExplicitGithubWritesMode` and `alwaysExplicitGithubTools`, which `resolveSendOptions` sets from the GitHub mode every turn.
- **Squad**: `prepareAndPublishGithubStack` plans the stack publish (`team-delivery`). A held publish leaves the run `needs_input` (`delivery_awaiting_approval`, or `delivery_refused` after a refusal), is pushed to the phone, and is released by "approve and publish" in the run's durable operations.
- **Policy grants**: `configured-grants.ts` adds an integration account's repository list (`integration-account:<id>`, host-only, edited in the Integrations hub), repository-scoped capability grants (`capability-grant:<id>`), a Bot's repository scope when it publishes automatically, and a team's consented repositories. A `gh` command names no account, so every GitHub account's list counts for it.
- **A person's own writes**: `human-github-write.ts` records a `human` receipt before stack publish and land, the restack note, review delivery, thread PR create and merge, the handed-off PR and the team's approve-and-merge. Issue publish and write-back pass a `person` caller to the broker.
- **Switch and report**: the Security card has one switch per category; `shadow-report.ts` returns one report per category and offers, for a repository, the Bot's list or the GitHub account's.

### Decisions made while implementing

- **`gh` writes follow the GitHub mode, not the outbound permission class.** Putting them in the outbound class would park unattended `gh` writes while GitHub is still in shadow mode. In shadow mode a `gh` write asks through the ordinary ladder, which bypass mode and allow rules can still skip; under GitHub enforcement it asks on every call.
- **A team's stacked delivery needs a person's consent.** Team configuration is not written only by people: plugins with `team:write`, the Agent SDK and automatic orchestration write it too. Turning stacked delivery on in the settings card records `githubDeliveryPolicy.consent` with the repositories bound at that moment, and only those are granted. Every other writer keeps the stored consent at most, and drops it when delivery is turned off.
- **A person's click is recorded, never planned.** The `person` authorization proceeds with a `human` receipt. Without it, a confirmed issue write-back would have been planned as a plugin write and held under enforcement.
- **A receipt names the integration account by id**, in `subject.input.integrationAccount`, so the shadow report can offer the list that would have let the write through. A write with no account (`gh`, a stack publish) offers the accounts on the repository's host.
- **No browser switch in 2a.** Nothing planned a browser submission before phase 2b, so the card showed no switch for it until 2b added one.
- **The shadow report boots the plugin runtime.** Which accounts are GitHub accounts comes from the integration registry, which a plugin fills when it loads, and Settings does not start the plugin runtime on its own.

### Known gaps

- Nothing in the app writes a capability grant yet, so the `capability-grant:<id>` source is read-only until something does.
- The GitHub MCP server's tools stay on the ordinary ladder, as decided.
- Enforcement of GitHub writes has unit and integration coverage but no run on a real desktop and phone yet (a Comment Bot answering the PR it was mentioned on, an unattended write to an unlisted repository approved on the phone, a cross-repository `gh` command in chat).

## Implementation (phase 2b)

Phase 2b, browser submissions, shipped in four work packages after a spike (plan: `docs/plans/2026-10-25-adr-0239-phase-2.md`; spike: `docs/research/2026-10-25-browser-submit-signal.md`). It has its own switch and starts in **shadow mode**: every submission is planned and recorded, and none changes, until a person turns it on in Settings → Security (`agentPermissions.outboundAuthorizationByCategory.browser: "enforce"`).

### Where it lives

- **Signal (spike)**: on local and remote Chromium a `context.route` holds every non-GET request a page sends, and `routeWebSocket` holds WebSocket frames. The embedded webview and the extension engine have no reliable signal: an injected script misses workers, `<a ping>` and cross-origin frames, and only `chrome.debugger` would hold requests in the extension, which ADR-0228 §6 rules out.
- **Runtime hold**: `services/workspace-runtime/src/submission-guard.mjs` (modes `off` / `observe` / `hold`, the action window plus a 3 s grace period) and the ops `browser.submission.configure/drain/resolve`. The runtime never waits for a person: the host drains the held submissions while the action runs and answers each. A refused navigation is fulfilled with `204`, so the page stays as it was; other requests are aborted. Local sessions route their whole context, so service-worker traffic is held too. A session driving the person's own Chrome routes per page, and the drain reports a page a service worker controls as `unguarded`.
- **Remote path**: companion commands `browser_submission_configure` / `_drain` / `_resolve` (configure and resolve are interactive writes, drain a read). The gateway takes no agent lease for them, so the host can still answer while a person has taken over the page.
- **Planner**: `lib/policy/action-review/plan-browser.ts` (`planBrowserSubmission`). The recipient is the request's origin, a WebSocket counting as its http(s) site; a page with no site is an unknown target. The global site list (`configuredSiteGrants`, policy ref `browser-sites`) and the asker's own lists (a running Bot's, a handler Bot's) allow it. A site a person refused within the request is refused; anything else asks. Receipts are `browser-submission` subjects on their own append-only channel, naming the asker (`browser:<session>`, `workflow:<id>`, `external-bridge:<client>`, `plugin:<id>`).
- **Chokepoint**: `lib/browser/submission-gate.ts` (`gateBrowserEngine`) wraps every engine `createBrowserAPI` hands out and the workflow browser node's engine (`resolveRunBrowserEngine`). On Chromium engines one drainer per page decides each site once per window; the action returns only after the questions it raised are answered, a refused site comes back as `outbound_refused`, and an allowed navigation waits for the page to load. On engines with no signal, and on `unguarded` pages, a click, double click, selection, drag or Enter / Space (with any modifier) on the page's site is planned before it runs. Typing, filling, hovering, focusing and scrolling are not.
- **Who is asked**: `lib/browser/submission-ask.ts`. A captured turn (`captured-turns.ts`, registered by `run-and-capture`) asks through its own responder, an IM card or a parked approval, with its wall clock held. A desktop chat or an External Bridge client asks on `components/outbound/outbound-ask-dialog.tsx` (allow once, allow for this request, refuse). Anything else, or an attended ask with no dialog mounted (a headless Host), parks for the cockpit and the phone. An ask ends after 9 minutes, the dialog after 5, and the fourteen submitting tools declare a 10-minute budget (`BROWSER_SUBMITTING_TOOL_TIMEOUT_MS`).
- **Lists, switch and report**: the global site list (`agentPermissions.outboundSites`, `components/settings/security/outbound-site-list.tsx`) and a Bot's list can hold sites. The Security card has a browser switch that says what the check cannot see. `shadow-report.ts` lists site rows, which can be allowed into the Bot's list for a Bot's own runs or into the global site list. Sites are named from the built-in browser's history, the origins passwords are saved for, the profiles' domain grants and the lists.

### Decisions made while implementing

- **The runtime does not wait for a person; the host does.** The control channel has a 180 s ceiling, and a person may take minutes. The runtime holds the request, and the host drains and answers it while the action is still running.
- **The browser tools wait for an answer.** A timeout refuses only that submission and fences nothing. A refusal fences the site for the rest of the request.
- **An External Bridge client has no request to attach a grant to**, so it can only allow once or refuse.
- **Service workers stay enabled.** A context route sees their traffic; blocking them would break sites.
- **No injected interception, no `debugger` permission.** Injection is not reliable enough to count as a signal, and the extension stays within ADR-0228 §6.

### Known gaps

- Data a page sends in a GET (a search, a GET form, a tracking pixel) is never held, on any engine.
- WebSockets a dedicated worker opens are invisible to `routeWebSocket` at both page and context level.
- Autosave while typing is not a submission on the no-signal engines, and a submission page script sends on its own there is missed.
- On a page a service worker controls in the person's own Chrome, the submission is decided before the action, not held.
- An ask cannot outlast 9 minutes.
- Enforcement of browser submissions has unit, jsdom and real-Chromium runtime coverage but no run on a real desktop yet (a held form submission on each reliable engine, approved).

## Follow-up: audit fixes (2026-10-26)

A read-only Codex audit of phases 1, 2a and 2b looked for bypasses and duplicate implementations. What it found, and what changed:

### Bypasses closed

- **`gh` classification.** `gh api` read a flag's value as the method (`-X PUT --jq -XGET` counted as a GET); every value flag's value is now consumed and only `-X` / `--method` set the method. `gh extension exec` runs extension code, so it is a write, not local. A command that changes the `gh` environment before `gh` runs (`export GH_REPO=…`, `source`, `.`, `eval`, or a `GH_REPO` / `GH_HOST` assignment outside the `gh` segment) drops the checkout fallback, so the repository is unknown rather than the checkout's. The sidecar's copy of the classifier is now generated from the host's source (`scripts/build/gen-sidecar-gh-command.mjs`, checked by `gh-targets.sidecar-parity.test.ts`) instead of maintained by hand.
- **A plugin's delivery goes where the host stored it** (`lib/connectors/plugin-destination.ts`). The policy planned a plugin's `enqueueSend` by its conversation key, while the runner sent it with the plugin's own reference, which could name another chat or, on Lark, another person (`receiveId`). A plugin's request is now sent with the delivery target the host stored for the conversation (refreshed by its inbound messages, or minted by `bootstrapConversation`), and a `replyTo` or `editTargetMessageId` must name a message the host saw in that conversation. Anything else is refused with `connector_delivery_destination`.
- **A message id is placed, not just remembered.** A plugin's `replyTo` or `editTargetMessageId` counted only while the inbound ledger still held the id, so a reply to an older message of the same conversation was refused. An id is now placed by the ledger, then by the message the host stored when it received it (`messages`, same bot and chat, any thread), then by the adapter's `messageRoute`: where a reply or edit of that id through the stored reference lands. Lark's reply and edit endpoints are keyed by the message id alone, so Lark reads the message's chat from the platform (`GET /im/v1/messages/:id`); Telegram, Slack, Discord and Matrix edit the chat a composite id (`chatId:messageId`) names, so they read the id; the other adapters keep every delivery in the reference's chat. An id placed in another chat is refused (`foreign-message`), one nothing can place too (`unplaced-message`). An id the Discord adapter puts in a URL path, and a Lark reply's, is escaped as one path segment (`discordPathId`), so no id can walk a request to another channel's endpoint (`../../222/messages/333`).
- **Direct sends and forwards are planned.** A plugin's deprecated `send` / `sendText`, a plugin's `forwardMessage` and the workflow node `action.connector.forward` go through `ConnectorDeliveryGateway.sendNow` / `forward`. These deliveries cannot wait as a draft, so the planner takes them as `immediate`: where another delivery would be drafted, they are refused (`unapproved`, returned as a failed result `connector_delivery_denied`). A direct send that names only a reference has an unknown recipient, which nothing authorizes. In shadow mode they go as before, and their receipts record that enforcement would have refused them.
- **An urgent push is planned for the people it notifies.** An urgent push (加急) re-notifies named members about a message already sent, so the planner takes its `recipients` (one `person:<bot>:<id>` target each) instead of the conversation, and every one must be authorized. A plugin's `sendUrgent` and an SLA escalation's urgent step go through `ConnectorDeliveryGateway.urgent`, which plans the push as `immediate` and sends nothing when it is refused (`delivery.urgent_direct` in the audit). `sendUrgent` takes `{ botRunId }` like `enqueueSend`. The escalation step's notice is planned too, where it was sent as a person's own send even into another conversation. Both of the step's sends are the sweep's unattended deliveries, and the step's target conversation and user ids are the list of the person who configured the policy (`escalation:conversation:<key>` or `escalation:adapter:<bot>`). For that to hold, a plugin's `createInstance` / `updateInstance` may not add a user id or target conversation to an urgent step (`connector_escalation_reach`); dropping one is allowed. Its patch may not use a key path either (`"defaultEscalation.steps"`), which Dexie's `update` would apply past the check, and the recipient list's own guard drops key paths into it (`"outboundRecipients.0"`).
- **`streamReply` cannot be planned.** A stream has no conversation key and sends one frame per update. While messaging is enforced, a plugin's `streamReply` resolves `false`, the documented "no streaming" answer, so the plugin falls back to a governed send. In shadow mode it streams, and the first frame of each stream (frames to the same platform reference less than a minute apart, `ConnectorDeliveryGateway.streamUnplanned`) writes a receipt for an unknown recipient on that bot, planned `deny`, and a `delivery.stream_unplanned` audit row, so the shadow report shows the streams enforcement would stop.
- **A handler Bot's list is lent to the run that names it.** The union of every running installation's list is gone. A plugin's code is shared by all its installations, so an action borrows a list only when it names its run and the host finds that run live and owned by the plugin (`liveBotRun`): `ctx.connectors.enqueueSend(…, { botRunId })`, and `botRunId` on a browser engine's routing context or `ensureLocalEngine`. The action is then planned in that installation's root and epoch, so its fence holds. An integration write names its run through the action's `binding` (the `bot` authorization), so the plugin path of the broker lends nothing. An action that names no run, including a callback a run left behind, is planned as the plugin's own.
- **Browser submissions.** A socket the page opened before the hold was installed leaves the page `unguarded` until it closes or the page loads a new document; a same-document navigation (`pushState`, a hash change) keeps it open, and the page unguarded. Choosing a file runs inside the action's submission window, so what the page posts at once is held. A failed drain no longer blocks an action in shadow mode.
- **People's answers are named as people's.** A HostState approval (a paired device) records the human receipt and promotes the tool call before it is resolved, naming the device. The Issue Loop names a person as its caller only when a person started the run (nobody for a wakeup or for an agent's `issue_run` call). An Issue sync push names a person as its caller only when every local edit it carries was a human's (`editedBy`, `localEditorOf`). An agent's or a team's edit stays planned by the policy.

### Duplicates removed

- The three chokepoint receipts (delivery, integration, browser) share one builder (`outbound-receipt.ts`: `outboundReceipt`, `outboundReview`, `jobAuthorizationOf`). The PR/issue number parser exists once (`threadNumber`). The browser ask uses `withTimeout` from `@cognia/primitives`.
- Kept apart on purpose: `siteTarget` / `repositoryTarget` and the forge remote parsers (`lib/stack/forge/remote.ts`, `lib/github/host.ts`) look alike but differ where authorization depends on them (host with port against hostname, the first path segments against the last). `captured-turns.ts` and the approval registry share a lifetime but not their data. The outbound ask store and the ask-user store share a queue shape but not their safety rules.

### Known gaps

- A plugin's reply to or edit of a message the host has no record of is refused while its bot is not running, when Lark will not return the message (the bot left the chat), and in a Lark conversation addressed to a person by open id, whose chat id cannot be compared.

## Consequences

- Sending to anyone other than the requester's own thread asks the first time in interactive chat, and later only when no grant covers it. Replying where you were asked stays silent.
- **Behaviour change**: an unattended run that sends to an unconfigured recipient now produces a draft or a parked approval instead of sending. `im.broadcast` to several targets from a schedule needs a `policy` grant listing them.
- "Always allow" disappears for outbound tools. Existing `toolRules` allow entries for those tools stop authorizing recipients. They are not deleted, because they still let the tool be used.
- A refusal holds across a reload, another tool, a reworded message and child runs, until the person who asked says something new.
- Every outbound decision has a receipt that names the authority, the grant and the instruction it served.
- The Dexie schema version is bumped once for the new index.
- **Phase 2a behaviour change**: a `gh` command that writes to GitHub asks in chat (it was treated as safe), and auto mode no longer approves one by itself. Once GitHub writes are enforced, an unattended write to a repository nobody allowed waits for approval, a Squad stack publish waits for "approve and publish", and `gh` writes ask even under bypass.
- **Phase 2b behaviour change**: the fourteen browser action tools may take up to 10 minutes. Once browser submissions are enforced, a submission to a site nobody listed asks the person at this computer or waits for approval, and the action waits for the answer.

## Rejected alternatives

- **Let a model judge authorization from the request.** A model can be prompt-injected by the very content it is judging. ADR-0070 rejected this for risk gates, and the contract already makes a model authority unrepresentable.
- **Fingerprint on the exact tool arguments.** Changing one word would get around the fence.
- **Keep the fence in memory.** It would still vanish on reload and still miss child runs. Receipts are already durable and already carry the session.
- **Treat every IM-bound run as external-send.** Rejected in ADR-0070 for the same reason: it would block the feature, and operators would turn the gate off.
- **Keep a session-level "always allow" for sends.** It recreates "authorize every recipient" with one click. A durable grant has to be a recipient list a person wrote.
- **Count any group member's message as a new instruction.** In a shared group, someone else could lift the requester's refusal.

## Verification obligations

- "Draft an email to A, don't send it." No path sends it. A Deny on the card fences A on every tool and child run, and a new message from the requester lifts the fence.
- An IM question answered into the same thread shows no card. The same agent sending to another group asks the first time.
- A scheduled `im.broadcast` to an unlisted group produces a draft, and with a `policy` grant listing the group it sends. A schedule or Bot trigger never advances the epoch.
- The fence survives a reload, and it blocks the same recipient from a subagent and from a teammate.
- A timeout does not fence: the next attempt asks again.
- Every outcome above writes a receipt with authority, grant scope and epoch, and every connector job carries `authorizedBy`.
- The digest turn's approval parks and is pushed instead of going unanswered.
- Phase 2: a Bot mentioned on a PR answers on that PR without asking, and the same run writing to another repository waits for approval under enforcement. Automation a person configured for a repository keeps working after enforcement is turned on. `gh pr create -R other/repo` in chat asks and names the repository, and under GitHub enforcement also under bypass. In shadow mode no GitHub or browser result changes. A form submission on a reliable engine to an unlisted site is held until a person answers, and on an engine with no signal a click that might submit is asked about before it runs.

## Glossary

- **Outbound action**: delivering content to a party other than the user, by a connector delivery from an automated source or by an outbound-classed tool.
- **Target**: the channel plus the normalized recipient of an outbound action.
- **Origin thread**: the conversation the current instruction came from. It is implicitly authorized.
- **Grant**: an explicit authorization for a target, scoped `once`, `instruction` or `policy`.
- **Instruction epoch**: the id of the requester's latest message in the root session. Grants scoped `instruction` and fence entries last until it advances.
- **Fence**: the set of targets a person refused during the current epoch, derived from deny receipts.
- **Category**: messaging, GitHub or browser. Each has its own shadow or enforce mode.
- **Site**: the origin a browser submission sends its request to, the browser's recipient.
