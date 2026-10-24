---
title: "0239 — An outbound action is authorized by the request, not by the tool"
description: "Agents can send to third parties through about ten paths, each with its own gate or none, and nothing records who a send was meant for or who asked for it. Builds the Action Review policy engine the contract already reserved: an outbound action needs an authorized recipient. The thread the request came from is implicitly authorized; any other recipient needs an explicit grant (this once, for this instruction, or a person-configured policy). A human denial fences the same send until the requester gives a new instruction, and an unattended run never sends to an unauthorized recipient."
---

# ADR 0239 — An outbound action is authorized by the request, not by the tool

**Status:** Proposed
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
| Browser click / fill, GitHub PR create and comment | Ordinary ladder or none |

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
- a tool call whose tool is classed outbound. There is one list, shared by the risk classifier's `EXTERNAL_SEND_IDS` and the sidecar's `outbound` permission class, with a parity test. The classifier's name normalization is fixed so that `connectors_send_message`, `send_session_message` and similar names match.

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
- for a run that has no conversation (a scheduled task, a Bot trigger), a person edits the task or installation, or writes in its session.

It does **not** advance on a scheduled or Bot trigger, a webhook, the model's own follow-up, a subagent's or teammate's message, or a message from anyone else in an IM group.

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

## Phases

| Phase | Scope |
| --- | --- |
| 1 | The engine; the outbound list and targets; origin, grant and draft/park order; the instruction epoch; the fence with its receipt fields and index; both chokepoints; `authorizedBy`; the digest responder; hiding "always allow" for outbound tools; the doc corrections |
| 2 | Browser form submission and GitHub create/comment, once a reliable "this click submits" signal exists |
| 3 | Model narrowing through `recommendation` |

## Consequences

- Sending to anyone other than the requester's own thread asks the first time in interactive chat, and later only when no grant covers it. Replying where you were asked stays silent.
- **Behaviour change**: an unattended run that sends to an unconfigured recipient now produces a draft or a parked approval instead of sending. `im.broadcast` to several targets from a schedule needs a `policy` grant listing them.
- "Always allow" disappears for outbound tools. Existing `toolRules` allow entries for those tools stop authorizing recipients. They are not deleted, because they still let the tool be used.
- A refusal holds across a reload, another tool, a reworded message and child runs, until the person who asked says something new.
- Every outbound decision has a receipt that names the authority, the grant and the instruction it served.
- The Dexie schema version is bumped once for the new index.

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

## Glossary

- **Outbound action**: delivering content to a party other than the user, by a connector delivery from an automated source or by an outbound-classed tool.
- **Target**: the channel plus the normalized recipient of an outbound action.
- **Origin thread**: the conversation the current instruction came from. It is implicitly authorized.
- **Grant**: an explicit authorization for a target, scoped `once`, `instruction` or `policy`.
- **Instruction epoch**: the id of the requester's latest message in the root session. Grants scoped `instruction` and fence entries last until it advances.
- **Fence**: the set of targets a person refused during the current epoch, derived from deny receipts.
