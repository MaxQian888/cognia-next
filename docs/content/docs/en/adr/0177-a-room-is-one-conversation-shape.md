---
title: "0177: A room is one conversation shape with three memberships"
description: "The character-team room, the shared session and the IM group become one room abstraction: one React-free runner executed by whoever holds the run, one roster projection, one settings row, and a room_send command so a companion hands its turn to the host instead of orchestrating on a phone. Squad stays an executor."
---

# ADR 0177: A room is one conversation shape with three memberships

**Status:** Accepted
**Date:** 2026-09-10
**Related:** ADR-0140 (AgentTeam to Squad), ADR-0149 (identity plane and collaboration), ADR-0131 (cross-shell inbox relay), ADR-0136 (cross-device placement), ADR-0059 (headless brain), ADR-0169 (run control), ADR-0175 (the RPC face)

## Context

The repository has four things called "group chat", and they do not know about
each other.

1. **The character-team room.** `ChatSession.kind === "team"` puts several
   personas in front of one local user. Routing, transcript building, round
   planning, supervisor dispatch and the streaming mirror all lived inside one
   React hook, `hooks/chat/use-team-chat.ts`, 1810 lines of closures. A paired
   phone therefore orchestrated the whole round itself and only each member's
   model call reached the host through `claude_send`. Put the phone to sleep
   mid-round and the round was gone. A headless host, which has no React tree,
   could not run a team room at all.
2. **The shared session.** The collab server (ADR-0149) puts several people in
   front of one assistant. It is switched off on both ends behind
   `NEXT_PUBLIC_SHARED_CHAT_ENABLED`, and its membership lives in the
   `collabChatMemberships` mirror that nothing on screen reads.
3. **The IM group.** A connector puts one bot in front of a platform's members.
   Activation is resolved in one place (`conversation-admission.ts`), a group
   can bind a Squad but never a character team, and only Lark and Matrix can
   enumerate who is in the room.
4. **The Squad** (ADR-0140). An executor with a task board. It is not a
   conversation shape and this ADR leaves it alone.

The pure decisions were already shared: who speaks (`team-router.ts`), what
each member reads (`team-transcript.ts`), who wrote a message
(`lib/chat/speaker.ts`), who is in the room (`lib/chat/room-roster.ts`). What
was not shared was everything around them: where the loop runs, who reports
its state, what a room remembers, and what the settings of a room even are.

Three further facts shaped the design.

- The hook keyed its streaming mirror by team session, not by member
  sub-session. Two members streaming at once would each read the other's
  half-written list as their base. Parallel replies were impossible by
  construction.
- Memory already has per-session switches (`memoryUse`, `memoryLearn`) that
  every recall and distillation site honours. A room's memory policy needs no
  new plane, only a place to set them.
- Paired-device writes reach TypeScript through one bridged channel
  (`desktop_writes_bridge.rs` into `dispatchCommand` in
  `desktop-write-source.ts`), and the headless brain installs the same file.
  One arm therefore serves both hosts. The desktop renderer must call the
  runner directly, because bridged arms are not Tauri commands.

A grill session on 2026-09-10 settled 27 decisions. This document records the
shape they add up to and the batches that deliver it.

## Decision

### A room is one shape

A **room** is a conversation with more than two participants. `RoomKind` names
where its membership is kept:

| Kind     | Session marker                          | Declared membership          | Who orchestrates                        |
| -------- | --------------------------------------- | ---------------------------- | --------------------------------------- |
| `team`   | `kind === "team"` and `teamId`          | `Team.members`               | the host that holds the run             |
| `shared` | `collaboration` present                 | `collabChatMemberships`      | the collab server (a lease, batch 5)    |
| `im`     | `platformBinding` present               | none until `chat.members.read` | the connector runtime on the host     |

`roomKindOf(session)` is the single classifier (`lib/chat/room/kind.ts`). A
direct chat is `null`. Squad runs are not rooms.

### Participants are a projection, not a table

`projectRoomParticipants` (`lib/chat/room/participants.ts`) reads the declared
side from whichever store the kind keeps, merges it with whoever has actually
spoken, and answers with a **completeness**: `full` when the declared source
vouches for the list, `partial` when a platform exposes only a count or the
admins (batch 4), `observed` when only speakers are known. A fourth table would
have been a second writer for two planes and an empty one for the third. The
header chip, the prompt roster and the composer's `@` completion read one
answer, and an IM group whose only known members are the ones who have spoken
says so instead of rendering as a three-person room.

### Room settings live on the session row

`ChatSession.roomSettings` (non-indexed, no Dexie version bump) carries:

| Field            | Type                                    | Live from | What it does                                                             |
| ---------------- | --------------------------------------- | --------- | ------------------------------------------------------------------------ |
| `instructions`   | `string`                                | batch 1   | injected into every member's system prompt as `## Room instructions`     |
| `memory`         | `boolean`                               | batch 1   | mirrored onto `memoryUse` and `memoryLearn` by `roomSettingsPatch`       |
| `replyMode`      | `"auto" \| "mention_only" \| "asleep"`  | batch 3   | stored now, honoured by the router later, labelled inert until then      |
| `mutedMemberIds` | `string[]`                              | batch 3   | stored now, honoured by the router later, labelled inert until then      |

`resolveRoomSettings` supplies defaults per kind. **A room with more than one
human defaults memory off** (`memoryUse` and `memoryLearn` false), with
`instructions` as the substitute for what a private memory used to carry, so no
member can recall one person's memory into a room it does not belong in. A team
room, which has one human, keeps memory on.

The mapping from `replyMode` to the planes, delivered in batches 3 to 5:

| `replyMode`    | Team room                                  | IM group (`InboundActivationPolicy`) | Shared room                              |
| -------------- | ------------------------------------------ | ------------------------------------ | ---------------------------------------- |
| `auto`         | `maxAutoRounds` as configured              | `always`                             | assistant answers every human turn       |
| `mention_only` | first round only on `@`, no auto rounds    | `mention`                            | answers only when addressed              |
| `asleep`       | no reply, the turn is stored               | `off`                                | a silence verdict is written to the audit |

### The runner is React-free and runs where the run is held

`RoomRunner` (`lib/chat/room/runner.ts`) is the orchestration the hook used to
be, as a class with two seams:

- **`RoomRunnerDeps`**: everything that does IO. The sidecar IPC, Dexie, the
  execution broker, the per-turn AI helpers. `createProductionRoomDeps()`
  binds the same lib modules on the desktop renderer and the headless brain.
- **`RoomRunnerSinks`**: everything that reports state. Session status, member
  status, the message slice, the steer queue, approvals, settings.
  `createStoreRoomSinks()` writes the zustand stores, which are plain modules
  and work in Node.

Streaming state is keyed by **member sub-session** (`runner-streaming.ts`).
Each member's events apply to `base + own slice`, never to another member's
partial output, and the room transcript the store and Dexie see is `base +
every active slice` in start order. With one member at a time this is
byte-identical to the old mirror. With several it is the shape batch 3's
parallel replies need.

Three execution hosts construct it:

| Host              | Construction                                   | Sidecar events                 | Member status                       |
| ----------------- | ---------------------------------------------- | ------------------------------ | ----------------------------------- |
| Desktop renderer  | `getHostRoomRunner()` from `useTeamChat`       | `onClaudeMessage` in the hook  | `useUIStore` into the members panel |
| Headless brain    | `getHostRoomRunner()` from the `room-runner` runtime | `onClaudeMessage` at boot | `room://member-status` host events  |
| Companion         | `getCompanionRoomProjector()`                  | the mirrored event channel     | derived from member events          |

The desktop's `useTeamChat` and the `room_send` arm share **one** runner per
process, so a phone's turn and a local turn on the same room go through one
steer queue and one interrupt set. A companion (Capacitor, web companion) never
orchestrates: its runner has persistence stubbed to no-ops and only projects
the member events it already receives into the store, so streaming text still
renders. Durable rows arrive through the sync mirror.

Approvals for a room with no open pane now follow the direct-chat rule: a
remote device holding a control lease on the room decides, a backstop denies if
it never answers, anything else is denied. The room used to auto-deny without
consulting the lease, which is why a phone could never approve a team member's
tool call.

### `room_send` and `room_stop` are bridged commands

Two new commands, `target: execution`, capability `agent.run`, transports
http/websocket/webrtc, resource `room`, advertised by the `room.host-run`
feature on both hosts:

- `room_send { sessionId, content?, webSearchContext?, attachmentManifest?,
  regenerate?, editMessageId? }` answers `{ accepted: true }` as soon as the
  host accepted the turn. A team turn can run for minutes and the bridge times
  out at 30 seconds, so the host runs it detached and the companion learns the
  outcome from the member events.
- `room_stop { sessionId }` interrupts every in-flight member and answers when
  the acks are in.

`callerDeviceId` is injected by the Rust RPC layer from the verified device
context and never read from the client payload. Pairing is same-person by
design, so the user row a companion turn persists carries
`collaboration.author = { kind: "human", id: <host's bound person, else the
local account>, displayName: <device label>, source: "device:<id>" }`. That is
the identity rule for every row written by a non-local principal: the speaker
resolver names who wrote it instead of collapsing every remote write into an
anonymous `User:`.

### Industry inputs adopted

Reply modes and a silence verdict (ChatGPT, Claude in Slack). Speaker
strategies, talkativeness and mute (AutoGen, SillyTavern). A transition graph
of handoff targets (AG2). Yield to the human while they type (SillyTavern). A
sticky active agent for unaddressed follow-ups (LangGraph swarm). Budgets on
turns and stalls (Agents SDK, Magentic-One). Agent messages are never consent
(Claude Code agent teams). Memory off in groups (ChatGPT). Status strings
(Slack). Scoped catch-up with citations (Slack AI, Gemini). A bot-origin flag
as the loop breaker (Slack, Discord, Telegram).

## Batches

| Batch           | Scope                                                                                                                                                                                                                                                                                          | Key files                                                                                                                                                        | Dormant until it lands                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| B1 foundation   | `lib/chat/room/` (kind, settings, participants, runner, streaming, deps, sinks, host), `room_send` and `room_stop`, the `room-runner` headless runtime, the room settings section in the members panel, the chip and the transcript roster on the projection                                   | this ADR's file list                                                                                                                                             | `replyMode`, `mutedMemberIds`                                             |
| B2 primitives   | `replyTo { messageId, preview }` on the message row, `reactions` (IM inbound events, outbound mirror when `send.reaction`), agent status strings from `tool-<name>` parts with auto-clear, unread divider from `sessionState.lastReadAt`, IM thread rendering                                     | `packages/agent-config-types`, `lib/db/messages.ts`, `lib/sync/handlers/messages.ts`, `components/chat/message-renderer.tsx`, `stores/ui`, `lib/connectors/bus.ts` | none, each type ships with its UI                                          |
| B3 orchestration| manual member picker in the composer, `Team.replyConcurrency: sequential \| parallel`, per-member interrupt in the message header, `handoffTargets` and `talkativeness` in `planAutoRound` and `selectPrimaryResponder`, mute, pause while the user types, sticky responder, `replyMode` live | `lib/claude/team-router.ts`, `lib/chat/room/runner.ts`, `components/settings/teams-section.tsx`, `components/chat/composer.tsx`                                   | none                                                                      |
| B4 IM           | group vs DM in the inbox, `chat.members.read` per adapter with completeness tiers, `ConversationOverrideRow.characterTeamId` through the runner with a persona prefix, Discord thread detection cached in `connectorConversationStates`, four connector tables into companion sync              | `lib/connectors/**`, `lib/connectors/adapters/*/`, `lib/data-governance/table-catalog.ts`, `lib/sync/handlers/`                                                   | `partial` completeness                                                    |
| B5 shared rooms | drop `NEXT_PUBLIC_SHARED_CHAT_ENABLED` for runtime detection (a collab connection plus `shared-chat` in `/health` features), silence verdict with an audit row, memory off by default, catch-up card with `@msg:` citations through the headless-turn fallback                                  | `lib/collab/**`, `lib/chat/room/`, `components/chat/`                                                                                                             | none                                                                      |
| Later           | human presence over the collab stream, human-to-human `@`, per-person approval, inviting people into team rooms, agent whisper, the runner as the shared-room lease executor, lifting the team-vs-shared exclusion                                                                            | `crates/cognia-collab-server`, `lib/collab/`, `components/chat/shared-session-panel.tsx`                                                                          | not typed yet                                                             |

Every dormant field is labelled on all three axes (hard rule 7): a comment on
the type, an inert label in the UI, and a test that pins the label.

## Consequences

- **A room runs where the run is held.** Desktop and headless hosts orchestrate
  in full. Companions observe and control under the attach lease. A web
  standalone shell is a read-only mirror. The browser extension is not
  involved.
- **Offline.** A team room runs on its host with no network. A shared room is
  reads plus drafts offline, and drafts are never sent optimistically.
- **The hook is an adapter.** `useTeamChat` builds store sinks, owns the event
  subscription, and forwards to the runner (host) or to `room_send` (companion).
  Its 85 existing tests are the regression net for the extraction. The
  orchestration itself is tested against fakes in `lib/chat/room/runner.test.ts`
  with no store or database in sight.
- **One more feature flag on the manifest.** `room.host-run` is what tells a
  client it may hand a room turn over. Without it the room is read-only from
  that device, and the client can say why.
- **Registration cost.** A bridged command touches the descriptor, both schema
  catalogs, `CALLER_DEVICE_ID_COMMANDS`, `KNOWN_COMMANDS`, the `data_sync.rs`
  dispatch arm, the feature manifest, and the generator's host category table
  (`room_` classifies under `agents`). The generator regenerates the OpenAPI
  documents, the Rust and CLI command tables and the catalog hash.

## Non-goals

- A cloud runtime that executes rooms outside a host.
- An in-app thread entity. `replyTo` is a reference on the row, and IM threads
  render the platform's `threadId`.
- Optimistic offline sends in shared rooms.
- Certification against real IM accounts. Adapters are tested against
  fixtures.
- Any change to the Squad.

## Implementation update (2026-09-10, batch 1)

Landed: `lib/chat/room/{types,kind,settings,participants,runner,runner-streaming,runner-deps,production-deps,store-sinks,runner-host}.ts`,
`lib/companion/{room-send-client,room-write-handlers}.ts`,
`lib/headless/runtimes/room-runner.ts`, the `room_send` and `room_stop` arms
and their registration, the `room.host-run` feature, the room settings section
in `components/context-workbench/panels/team-members-panel.tsx`, the chip and
`lib/chat/team-transcript.ts` on `projectRoomParticipants`, and the thin
`hooks/chat/use-team-chat.ts` adapter.

Two things implementation overturned from the plan. The transcript roster
keeps observing only user turns, because a member's own replies are already on
the declared side and observing them added nothing. And the companion
projection derives the room's busy state from member events with a short idle
grace, rather than from a status frame the host would have had to publish,
because the events were already on the wire.
