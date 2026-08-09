# Codex attached agent threads vs. Claude Code cross-session messaging

**Date:** 2026-08-09  
**Scope:** Codex desktop subagent threads, Claude Code cross-session messaging, and Claude Code Agent Teams.  
**Method:** Primary sources only: official OpenAI/Anthropic documentation, official product posts, and first-party public source code or changelogs.

## Executive conclusion

These features are related, but they are not direct equivalents.

- A Codex “additional” or attached chat is best understood as an **agent thread inside the current root task tree**. Codex spawns it for a bounded subtask, optionally forks parent turns into its context, routes messages by a tree-scoped task path, and returns completion into the parent workflow. The Codex app exposes the child thread for inspection. OpenAI's public documentation calls this an **agent thread**; it does not define “attached chat” as a separate protocol concept. [OpenAI subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- Claude Code **cross-session messaging** connects **independently started sessions**. `ListAgents` discovers reachable sessions and `SendMessage` sends plain text between them. It never transfers conversation history or files, and there is no shared parent lifecycle or task list. [Anthropic cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- Claude Code **Agent Teams** are the closer structural comparison to Codex subagent workflows: a lead spawns independent teammate sessions, teammates have separate context windows, and the team has mailboxes plus a shared task list. Agent Teams go further than Codex's documented parent-collection model by making peer-to-peer discussion and self-coordination first-class, but they remain experimental. [Anthropic Agent Teams](https://code.claude.com/docs/en/agent-teams)

In short:

```text
Codex attached agent thread: root task -> child task tree -> summaries/completions return upward
Claude cross-session message: session A <-> session B, with no shared history or lifecycle
Claude Agent Team: lead + peer teammates + shared tasks + mailboxes
```

## Side-by-side model

| Dimension          | Codex attached subagent thread                                                                                             | Claude Code cross-session messaging                                                           | Claude Code Agent Teams                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Unit               | Child agent thread in one root task tree                                                                                   | Independent Claude Code session                                                               | Independent teammate session under one lead                         |
| Topology           | Hierarchical task paths; descendants can themselves spawn children                                                         | Horizontal peer discovery by session name                                                     | Lead plus named peers                                               |
| Creation           | `spawn_agent(task_name, message, fork_turns, ...)`                                                                         | User starts sessions separately; messaging does not create them                               | Lead spawns the first teammate, which forms the team                |
| Context            | `fork_turns`: `all`, `none`, or last N parent turns                                                                        | No history transfer; text only                                                                | Project context plus spawn prompt; lead history is not copied       |
| Coordination state | Root-thread agent tree and per-agent mailbox/activity                                                                      | Per-session inbox socket; no shared task state                                                | Local team config, JSON mailboxes, and shared task list             |
| Messaging          | `send_message` queues; `followup_task` can wake an idle non-root child                                                     | `SendMessage`; delivered, held, or refused by receiver                                        | `SendMessage` plus structured team protocol and shared tasks        |
| Human visibility   | App surfaces each child thread and its returned summary; user asks Codex to steer/stop it                                  | Incoming text is shown in the receiving transcript and then collapsed to a `Message from` row | User can open a teammate transcript and message or stop it directly |
| Files              | App supports per-agent worktrees, but a runtime child is not by itself proof of a distinct worktree                        | Sessions may use separate worktrees, independently of messaging                               | Teammates do not automatically get isolated worktrees               |
| Lifecycle coupling | Child is addressable inside the live root task tree; parent orchestrates wait, follow-up, interrupt, and result collection | Sessions live and exit independently; reachability lasts while the receiver binds an inbox    | One team per lead session; runtime team config is cleaned at exit   |
| Best fit           | Bounded delegated work whose result feeds the main task                                                                    | Mid-task handoffs/status between sessions the user already runs                               | Work that benefits from peer debate and shared coordination         |

## 1. Codex: an attached chat is a child agent thread

### Concept and architecture

OpenAI describes Codex subagent workflows as specialized agents running in parallel and returning their results into one response. In the desktop app, each subagent thread is surfaced so the user can inspect its work and the summary returned to the main chat. The documented purpose is to keep exploration, test output, and logs out of the main context while returning distilled results. [OpenAI subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)

The open-source runtime makes the hierarchy explicit. A child receives a canonical path such as `/root/task1/task_3`; agents on another branch of the tree must use the canonical path to address it. `list_agents` is limited to “live agents in the current root thread tree,” so this is not a general peer-discovery API for unrelated top-level Codex chats. [Codex multi-agent tool schema, pinned source](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L2497-L2530)

### Context creation and isolation

Current Multi-Agent V2 supports three context-fork modes:

- `all` (the default): fork the full parent thread history;
- `none`: start without surrounding parent history;
- a positive integer such as `3`: fork only the most recent turns.

The initial task message remains required in every mode. A full fork improves continuity but copies more parent context; `none` gives cleaner isolation but requires a self-contained delegation prompt. [Codex `fork_turns` schema](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L3110-L3189)

The spawn implementation records `parent_thread_id`, `parent_turn_id`, environment selections, and a structured initial inter-agent communication that triggers the child turn. This confirms a parent/child runtime relationship rather than merely opening another UI transcript. [Codex V2 spawn implementation](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)

Context isolation is separate from filesystem isolation. OpenAI's app announcement says app agents run in separate project threads and that built-in worktree support lets each agent work on an isolated code copy. The runtime spawn path forwards the selected environment, but its existence alone does not guarantee that every child gets a newly created worktree. An implementation should model **conversation fork** and **workspace/worktree assignment** as separate decisions. [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)

### Message and lifecycle APIs

The current public source exposes two different message semantics:

- `send_message(target, message)` queues a note and explicitly **does not start a new turn**;
- `followup_task(target, message)` is an actionable follow-up: it wakes an idle non-root target, or reaches a running target at a safe sampling/tool boundary.

Both share the same delivery path; the implementation difference is `QueueOnly` versus `TriggerTurn`. A follow-up cannot target the root agent. [Codex message tool schema](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L2300-L2407), [Codex V2 message implementation](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs)

Other runtime controls are tree-scoped:

- `list_agents` lists live descendants visible from the current root tree;
- `wait_agent` waits for mailbox activity, user steering, or timeout rather than polling a transcript;
- `interrupt_agent` stops the current child turn but keeps the child addressable;
- a child completion is delivered as a structured `FINAL_ANSWER` back into the tree.

The app layer exposes Active/Done inspection and allows the user to ask Codex to steer, stop, or close a child. [OpenAI subagent management](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Codex V2 wait implementation](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)

## 2. Claude Code cross-session messaging: horizontal, text-only handoff

### Concept and transport

Cross-session messaging, introduced for Claude Code v2.1.224+, lets Claude discover and message other sessions owned by the user. `ListAgents` discovers reachable targets; `SendMessage` delivers to one by name. The payload is plain text only: not conversation history, files, permissions, or configuration. Anthropic directs users to resume a session when they need to move full context. [Anthropic cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)

On one machine, delivery uses a per-session Unix socket and never passes through Anthropic servers. Sessions register themselves through local files, so host and container sessions cannot see each other unless they share that filesystem. Sessions on another machine or Claude Code on the web are reply-only through Remote Control; a local session cannot initiate a new remote exchange. [Cross-session transport and reachability](https://code.claude.com/docs/en/cross-session-messaging#message-sessions-on-other-machines)

This is the clearest architectural difference from Codex attached threads: Claude's sessions already exist independently, have no common root, and messaging does not establish ownership or a shared completion contract.

### Delivery lifecycle

A receiving Claude reads a message between tool calls, so an active tool call is not interrupted. If the session is idle, message delivery starts a new turn. The receiver independently classifies the message as:

- **Delivered:** enter the receiving conversation and consume usage like a user prompt;
- **Held:** remain undelivered until approval or a later policy/mode change;
- **Refused:** be dropped.

`crossSessionInbound` can force `accept`, `hold`, or `refuse`. Held approval dialogs expire after five minutes by default, and a session holds at most 100 messages before dropping the oldest. Accepted messages waiting for Claude to read are capped at 50; repeated message loops are throttled and duplicate repeats are dropped. [Cross-session delivery controls and limits](https://code.claude.com/docs/en/cross-session-messaging#message-delivery)

Interactive and non-interactive lifecycles differ. `claude -p` binds an inbox socket but cannot display an approval dialog, so a held message remains held unless settings later allow it. Bare mode binds no socket and is not discoverable. [Cross-session non-interactive sessions](https://code.claude.com/docs/en/cross-session-messaging#non-interactive-sessions)

### Authority boundary and visibility

The receiver is told that the message came from another Claude session, not the user. A peer message cannot approve permissions, change configuration, or execute slash commands; receiver-side permission checks still apply to any requested action. The incoming text appears in the conversation with its sender and later collapses to a `Message from` row that the user can expand. [Cross-session incoming-message rules](https://code.claude.com/docs/en/cross-session-messaging#how-a-session-treats-an-incoming-message)

This is a valuable security property for any Cognia analogue: a message is information or a request, never delegated user consent.

### Availability constraints

Cross-session messaging requires Claude Code v2.1.224+, macOS or Linux (including WSL 2), and supported providers. It is unavailable on native Windows and on Amazon Bedrock, Claude Platform on AWS, Google Cloud Agent Platform, and Microsoft Foundry. Some telemetry/feature-flag-disabling environment settings also disable it. [Cross-session availability](https://code.claude.com/docs/en/cross-session-messaging#availability)

## 3. Claude Code Agent Teams: the closer Codex analogue

Agent Teams consist of a fixed lead, separate teammate instances, a shared task list, and per-agent JSON mailboxes. A teammate loads normal project context (`CLAUDE.md`, MCP servers, and skills) plus its spawn prompt, but not the lead's conversation history. Teammates message one another by name, messages arrive automatically, and all teammates can inspect and claim shared tasks. [Agent Teams architecture and context](https://code.claude.com/docs/en/agent-teams#architecture)

As of the documented v2.1.178 lifecycle, the first teammate spawn forms one implicit team for the session; the old `TeamCreate` and `TeamDelete` tools no longer exist. Runtime config under `~/.claude/teams/{team-name}/` is removed when the session ends, while the local task list under `~/.claude/tasks/{team-name}/` persists according to transcript retention. [Agent Teams lifecycle](https://code.claude.com/docs/en/agent-teams#how-claude-starts-agent-teams), [official Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

The important contrast is peer coordination:

- Codex documentation emphasizes the main thread collecting child results into a consolidated response.
- Claude subagents likewise report only to the main agent.
- Claude Agent Teams add direct teammate-to-teammate discussion, task claiming, and shared dependency state.

Agent Teams do **not** automatically isolate teammate edits in worktrees. Anthropic warns that two teammates editing the same file can overwrite each other and recommends disjoint ownership. Worktree isolation is separately available for manually started sessions and subagents; Claude's desktop app creates a worktree for every new session, but that is not the same as Agent Team membership. [Claude parallel-agent comparison](https://code.claude.com/docs/en/agents), [Claude worktree documentation](https://code.claude.com/docs/en/worktrees)

Agent Teams remain experimental and disabled by default. Current documented limits include: in-process teammates are not restored by `/resume` or `/rewind`; task status can lag; shutdown waits for a current request/tool call; a session has only one team; nested teams are unsupported; and the lead cannot be transferred. [Agent Teams limitations](https://code.claude.com/docs/en/agent-teams#limitations)

## 4. Failure-mode comparison

### Codex attached agent threads

- **Bad delegation boundary:** OpenAI recommends bounded, independent work; parallel write-heavy work can cause conflicts even when the conversations are separate. [OpenAI subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- **Missing context:** `fork_turns: none` intentionally supplies no surrounding conversation, so omitted requirements are not recoverable from the parent transcript.
- **Wrong delivery primitive:** `send_message` does not wake an idle child; use `followup_task` only when another turn is intended.
- **Invalid target/input:** empty messages are rejected; root follow-ups are rejected; unresolved paths surface an agent-target error. [Codex V2 message implementation](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs)
- **Wait is not proof of completion:** `wait_agent` can return on any mailbox update, user steering, or timeout. The orchestrator must inspect status/result separately.
- **Approval cannot surface:** in non-interactive runs, an action that needs a fresh approval fails and the error returns to the parent workflow. [OpenAI approvals and sandbox controls](https://learn.chatgpt.com/docs/agent-configuration/subagents#approvals-and-sandbox-controls)
- **Version sensitivity:** the detailed APIs above come from Codex `main` at commit `94937de51ba28d4b308dbe1b8472d6fe1dddad28`; they are implementation evidence, not a promised stable desktop extension API.

### Claude Code cross-session messaging

- The target may be absent because its process exited, bare mode exposes no inbox, or a container cannot see the host registry/socket.
- Delivery can be held or refused by receiver policy; cross-machine targets are reply-only.
- Plain text does not synchronize history, files, branches, task state, or permissions.
- Held unattended `-p` sessions cannot show the approval dialog; queue caps can drop old messages.
- Cross-session messages cannot provide consent or bypass a receiver's permission boundary.

### Claude Code Agent Teams

- Resuming the lead does not restore in-process teammates.
- Shared task status can lag and block dependents even when work finished.
- Teammates can overwrite each other when they edit the same file.
- More peers increase token cost and coordination overhead; Anthropic recommends starting with roughly three to five for work that genuinely benefits from parallel debate. [Agent Teams best practices](https://code.claude.com/docs/en/agent-teams#best-practices)

## 5. Intended use and design implications for Cognia

These sources suggest three separate product primitives rather than one generalized “chat-to-chat communication” feature:

1. **Delegated child task** — parent-owned lifecycle, explicit context fork, child transcript, completion returned upward. This is the Codex attached-thread model.
2. **Independent-session handoff** — discover an already running session and send a narrow, non-authoritative text message. This is Claude Code cross-session messaging.
3. **Agent team** — lead, peer roster, mailboxes, shared tasks/dependencies, and peer discussion. This is Claude Code Agent Teams.

Combining all three into a single `sendMessage(sessionId, text)` API would erase load-bearing semantics. A Cognia protocol should carry at least:

- relationship: `child`, `peer`, or `team_member`;
- delivery intent: `note` versus `trigger_turn`;
- context mode: none, selected snapshot, last N turns, or full fork;
- authority: always `untrusted_agent_message`, never user consent;
- addressing scope: current task tree, current team, or independently discoverable session;
- workspace binding: same checkout, explicit worktree, or unrelated workspace;
- delivery outcome: delivered, queued, held, refused, expired, or target unavailable;
- lifecycle ownership: who may interrupt, resume, close, or archive the recipient;
- observability: sender, exact payload, target, timestamp, receipt, and resulting turn/result linkage.

Recommended UX naming should preserve these boundaries:

- **Subtask** or **child agent** for Codex-like attached threads;
- **Message another session** for Claude-like independent session handoff;
- **Team** for shared-roster/shared-task collaboration.

The safest initial implementation is the delegated-child model plus explicit inspection and receipts. Cross-session peer messaging should be a separate opt-in capability with receiver controls, and a team layer should be added only when shared task state and peer coordination are first-class product requirements.

## 6. Current Cognia fit and remaining gap

Cognia should not treat this research as a reason to build another Agent Team subsystem. The repository already has most of the Claude Agent Teams coordination layer:

- ADR-0066 defines the cross-surface Agent Team task board, dependency-aware task state, roster, desktop/mobile control plane, and guarded task transitions. [ADR-0066](../content/docs/en/adr/0066-agent-team-task-board.md)
- `team_send_message` already supports teammate-originated direct messages and broadcasts. [Team built-in tools](../../lib/claude/team-builtin-tools.ts)
- The team tool surface also includes shared-memory publication/read APIs and consensus coordination, so agents do not need to encode every coordination fact as chat text. [Team built-in tools](../../lib/claude/team-builtin-tools.ts)
- Cognia already suppresses acknowledgement-only noise, duplicates, rapid pairwise ping-pong, and per-sender floods before a teammate message reaches the mailbox. [Message guard](../../lib/ai/agent/team/message-guard.ts)

Those capabilities are team-scoped. They do not by themselves provide Claude-style discovery and messaging between independently started Cognia sessions, nor Claude's receiver-side `accept` / `hold` / `refuse` policy. The existing Codex App dispatch research solves another adjacent problem—copying a Cognia transcript into a normal persisted Codex task—and should not be conflated with live inter-session messaging. [Codex App conversation dispatch research](./codex-app-conversation-dispatch-2026-08-06.md)

The implementation-relevant gaps are therefore:

1. **Attached child sessions:** a durable parent/child session relation, explicit context-fork metadata, result linkage back to the parent, lifecycle ownership, and an inspectable child transcript.
2. **Independent-session messaging:** a live peer registry, sender/receiver identity, queued delivery at safe turn boundaries, delivery receipts, receiver policy, expiry/capacity controls, and an explicit agent-origin trust label.
3. **Workspace isolation metadata:** conversation ancestry must remain separate from checkout/worktree ownership, because neither product makes thread ancestry alone sufficient proof of file isolation.

Recommended Cognia boundary:

- Reuse the current Agent Team board, mailbox, shared memory, and anti-loop guard for team members.
- Add attached child sessions as a parent-owned execution primitive, not as ordinary team messages.
- Add independent-session messaging only as a separate opt-in control-plane capability. Its payload should be plain text plus provenance and correlation metadata; it must never carry user approval authority.
- Route an incoming peer message into an idle session as a new turn, or into an active session only at a safe boundary. Persist `delivered`, `held`, `refused`, `expired`, and `target_unavailable` outcomes so UI and automation do not mistake enqueue success for consumption.

This keeps Cognia's three existing concepts clean: Agent Team collaboration remains team-scoped, Codex dispatch remains a transcript handoff, and peer messaging becomes a distinct live-session protocol.

## Primary sources

### OpenAI

- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Codex multi-agent tool schema, pinned source](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- [Codex Multi-Agent V2 spawn implementation](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)
- [Codex Multi-Agent V2 messaging implementation](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs)
- [Codex Multi-Agent V2 wait implementation](https://github.com/openai/codex/blob/94937de51ba28d4b308dbe1b8472d6fe1dddad28/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)

### Anthropic

- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Run agents in parallel](https://code.claude.com/docs/en/agents)
- [Worktrees](https://code.claude.com/docs/en/worktrees)
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
