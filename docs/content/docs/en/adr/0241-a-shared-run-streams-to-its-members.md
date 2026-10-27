---
title: "0241 — A shared run streams to its members"
description: "A server-authoritative shared conversation already let several people watch one agent run, but the executor re-sent the whole reply every second as a stored correction, members re-pulled over HTTP on every socket ping, tool cards arrived without their input, and a local conversation could only be shared with its entire history. This ADR keeps the stored event log as the record and adds a never-stored live channel that reuses the member-reply frame codec, one shared projection with per-tool safe inputs, and a share-from-now-on branch that reuses summarize-then-branch."
---

# ADR 0241 — A shared run streams to its members

**Status:** Proposed
**Date:** 2026-10-26
**Related:** [ADR-0149](./0149-a-person-is-not-a-device) (the collaboration plane and its shared AI sessions update), [ADR-0177](./0177-a-room-is-one-conversation-shape) (a shared session is the `shared` room kind), [ADR-0206](./0206-a-workspace-streams-its-changes-instead-of-being-polled) (the process-local broadcast this channel also uses), [ADR-0103](./0103-cross-host-session-handoff) (why a shared session is never moved by copy)
**Plan:** `docs/plans/2026-10-26-shared-run-live-projection.md`

## Context

A comparison with claude-share asked what Cognia should take from a tool built around several people watching one Claude Code session. Most of its machinery already exists here in a stronger form: server-authoritative membership and roles, an ordered event log, one lease-holding executor, a FIFO queue, approvals, audit, and per-member file grants. Of every multi-party shape in the app (team rooms, member chats on an org Host, IM groups, share links, canvas), the shared session is the only one where different human accounts watch the same agent. A source check on 2026-10-26 found that this one path is slow, lossy and partly unsafe.

1. **The executor republishes the whole reply every second, and every copy is stored.** `shared-run-coordinator.ts` re-reads the in-progress assistant messages on a 1 s interval and posts any changed one as a `message.corrected` event that carries the complete `parts` array. Each of those is a Postgres row.
2. **Members do not read the stream.** The session WebSocket forwards each stored event, but `connectSharedSessionStream` ignores the payload and re-pulls over HTTP from its cursor. The 2026-08-29 plan said the socket "owns low-latency increments". The code never did that.
3. **Tool cards arrive empty.** `sharedAssistantParts` always publishes `input: {}`, turns the output into a JSON string, and drops reasoning, file, image, source and data parts. A member sees "Bash ran" with no command, and an edit with no diff.
4. **Three defects sit on this path.**
   - `stream_loop` forwards events without the redacted-message projection that `list_events` applies. A correction posted after a redaction is stored and broadcast raw.
   - When the PII sweep in `sharedAssistantParts` throws, the 1 s tick swallows the error. That message, and every assistant message after it, is then never published.
   - The publish chain has no in-flight guard, so passes queue behind a slow server.
5. **Sharing always means sharing everything.** `convertLocalSessionToShared` imports every local message and attachment. The server route and `createSharedSession` already accept `importing: false`, and `ensureLocalProjection` already materialises an empty remote session, but nothing calls them that way.

A parts-level live protocol already exists. `lib/chat/transcript/live-frames.ts` encodes successive part arrays of one reply into patches and periodic keyframes, ends a reply with a `settled` or `reset` frame, and marks a device stale after a missed frame until the next keyframe. The member-reply path of the multi-user Host (`transcript://live`) uses it. Only its transport is person-scoped.

The proposal under comparison suggested streaming `CanonicalAgentEvent`s to members. That does not fit the code. At least four producers write canonical envelopes, each with its own sequencer, into `workflowRunEvents`; no chat surface renders from them. Every chat surface renders message parts, built by `applySdkEvent` or `applyExternalAgentEventToParts`. Parts are what members should receive.

## Decision

### The stored log stays the record; a live channel is added beside it

`message.created` and `message.corrected` remain the only record of a shared reply. Nothing reads a live frame as history, and a member that never sees one still converges from the log.

While a reply streams, the executor stores it **when it settles and at most every 10 s before that**, instead of every second. Members on this version draw the reply from live frames between those writes. Clients that do not negotiate the live channel see the reply in 10 s steps. An executor whose collaboration server does not advertise the `/health` feature `shared-chat-live-v1` keeps the 1 s cadence, so an old server never makes the transcript slower than today.

### Live frames reuse the member-reply codec

The executor feeds the projected parts of each in-progress reply to `createTranscriptLiveEncoder`. It uses a 250 ms interval, the codec's 2 s keyframe, and the codec's 200 KiB frame budget. The frame shape, the patch and keyframe rules, `settled`, `reset` and the stale-until-keyframe rule are unchanged. They move from a person-scoped module to a transport-neutral one that both paths import.

- `replyTo` is the queued request's message id. `messageId` is a message this run created.
- `settled` is sent only after the final `message.corrected` was accepted. Its `afterRevision` is that event's server sequence, so a member keeps drawing the finished reply until its applied cursor reaches it, using the existing `settledReplyCaughtUp` rule and its 10 s ceiling.
- A frame over budget becomes a `reset`, and members fall back to the stored log, as on the Host.

### Upload is a run-token request; nothing is stored

`POST …/sessions/{session}/runs/{run}/live` takes one frame. The server authenticates it exactly like a run event: the `x-cognia-run-token` header must match a live, unexpired lease, and the holder must still have `StartRun` on the session. It also checks:

- `messageId` must be a message this run created;
- the frame must match the codec's shape;
- the body must be at most 256 KiB;
- the target must not be redacted.

The frame is broadcast and never written. The check is the store-level admission a stored message event passes, including the rollout gates for shared chat and shared execution (terminal run events keep their weaker gate, so a stopped run can still finish), and it is never cached, so an emergency stop or a read-only switch ends frames at once.

### Download is a negotiated subprotocol on the existing socket

A client offers `cognia.chat.v2` before `cognia.chat.v1`. On a v2 socket every message is an envelope: either `{type: "event", event}` for a stored event, or `{type: "live", frame}` for a live frame. A v1 socket is unchanged. It never receives a live frame, so an old client never re-pulls ten times a second.

Live frames travel on their own per-session broadcast channel. A receiver that lags on that channel skips frames instead of closing the socket: the next keyframe repairs it, and a slow viewer must not lose its stored-event stream over a dropped preview. The stored-event channel keeps its close-on-lag rule.

Every forwarded stored event still re-checks visibility. A live frame relies on a per-socket standing check that is refreshed at least once a second, and immediately on a `member.updated` policy frame. A revoked or removed member therefore stops receiving live frames within one second. The server also keeps one tombstone per session, written before a redaction is broadcast and checked as each live frame leaves, so a frame queued before the redaction can never redraw it.

### One projection, safe inputs, nothing silently dropped

`sharedAssistantParts` remains the only projector, and both the stored correction and the live frame use its output.

- **Memoised per source part.** Results are cached by source-part identity. A part the chat store did not replace keeps the same projected object, so the encoder's identity prefix holds and redaction runs only on changed parts.
- **Tool detail has two tiers, set per shared session.** The default is `summary`: the tool name, workspace-relative paths, diff stats for edits and patches, and the host of a fetched URL. Commands, patterns, queries and edit bodies are not shared. An owner or maintainer may switch a session to `full`, after a warning. Passing pattern redaction does not make a command or an edit body safe to share, so sharing them is the session's explicit choice. The setting lives on the server session, so every executor applies the same tier, and a change applies from the next publication.
- **In `full`, tool inputs pass through a per-tool allowlist.** Built-in tools, and their external-agent equivalents, keep only the fields their cards read:
  - the command of a shell tool;
  - the workspace-relative path of a file tool;
  - the old and new strings of an edit;
  - the patch of `apply_patch`;
  - the pattern of a search;
  - the URL of a fetch;
  - the query of a web search;
  - the todo list.
  Each field is redacted and length-capped. Absolute paths outside the workspace are dropped. MCP and plugin tools keep only their name and redacted output.
- **What is still not shared.** Reasoning, images, files, sources and data parts are not shared. Files keep going through the FileSpace grants of ADR-0222.
- **A part that fails the PII sweep is withheld, not thrown.** It is replaced by a `data-shared-withheld` part that members render as a labelled placeholder. The rest of the reply still publishes, and the executor records a diagnostic. The owner's own transcript keeps the original.
- **An unfinished secret is never released.** The redactor matches a secret only once it is complete, and several of its patterns span spaces and newlines. While a reply streams, the released text is therefore computed over the whole message, every text part joined, never part by part:
  - The whole text is redacted, and only the redacted text up to 256 characters before the end is released. The cut point is mapped through the redaction's offsets.
  - A test pins that window against the longest pattern of every bounded secret kind.
  - Unbounded kinds stay withheld from their opener onwards until the redactor has matched them. These are private keys, JWTs and URL credentials. At settle, any of them still unmatched stays withheld in the record too.
  - The same rule governs live frames and the stored corrections written before the reply settles.
  - A tool's input is shared only once its arguments are complete.
- **A tier change cannot be missed.** Every publication names the tool-detail revision it was projected under, and the server refuses a stale one. An executor that missed the policy notice is corrected by its next publication.

### The three defects are fixed first

- `stream_loop` applies the redacted-message projection to what it forwards.
- A run correction whose target is already redacted is refused when it is appended.
- A publish pass that is still in flight makes the next tick a no-op instead of queueing another.
- PII failure follows the withheld rule above.

### Members draw the live reply over their own list

The member's chat list keeps rendering from the chat store, which is fed by the Dexie projection. A transient live reply is merged into it by message id, using the tail rule of `withLiveTurn`. Frames name remote message ids; a member maps them to its projected local ids through the same function the projection uses. While a run is active (from its run events and lease, not from frames), the member's composer shows it. A live reply is dropped when no frame arrives for 6 s, on a redaction, on socket close and on session teardown, so a crashed executor never leaves a reply streaming. A run streams one reply at a time: the executor drains its uploads and settles a reply before the next one starts, and a member refuses frames for a reply that has ended. A terminal run event ends the running state, but a settled reply stays drawn until the member's log has caught up with it. The executor's own device already streams locally and ignores its run's live frames.

### Sharing can start from now on

Sharing a private conversation opens one dialog with two choices. **Share from now on** is the default.

- **Share from now on** creates an empty Active shared session through `createSharedSession(importing: false)`. It opens the session's `shared:` projection, and records on the private row a link to it. The private conversation and its history are not changed, uploaded or shown to anyone.
  - The owner may add background. A draft comes from the existing summarize-then-branch summary (`summarizeMaterial`, PII-gated). The owner edits it, and it is posted only if the owner confirms. It is posted as the owner's first message, so every executor rebuilds the same context from the log.
  - The agent in the shared branch knows only what that log holds. That is the point: a shared session's context must not depend on which member's device executes it.
- **Share full history** is today's conversion, with today's warning.
- Team conversations stay refused in both modes. A shared session cannot carry a team yet.

## Non-goals

- **Human presence, read receipts, reactions, and a human-only discussion channel.** These stay in ADR-0177's "Later" row.
- **Developer previews for session members, moving a shared session's executor to an always-on Host, and sharing team conversations.** Each needs its own transport or identity decision and gets its own ADR.
- **Live delivery to shared sessions not open on a member's device.** They keep the 30 s pull and ADR-0207 notifications.
- **Horizontal scale of the collaboration server.** Both broadcast channels are process-local, as ADR-0206 already records.
- **Streaming canonical agent events to members.**

## Consequences

- Postgres writes for a streaming reply drop from one full-reply row a second to one every 10 s plus the settled one.
- Members see tokens within about a quarter second, and tool cards show what ran.
- Clients that do not negotiate v2 see 10 s steps when the executor is on this version. That is the accepted cost of the lower write rate.
- An old server keeps the old 1 s behaviour, because the executor falls back.
- The live channel adds per-frame HTTP requests on the executor (at most four a second per run) and a once-a-second standing check per live socket on the server.
- By default a member now sees which files a tool touched and how much changed. In a session switched to `full` a member reads commands and diffs that the 2026-08-29 design withheld. They are redacted and allowlisted, and the switch says so.

## Implementation notes (2026-10-26)

Built as decided, with these refinements found while building. Status stays Proposed until the two-member smoke (plan WP7) runs.

- **Single-flight by skipping, not queueing.** While a live POST is in flight, the next streaming tick is skipped rather than queued; the tick after encodes the newest parts. The encoder therefore never runs ahead of the wire, so no patch is lost in a queue and no forced keyframe is needed. A `settled` or `reset` frame waits for the in-flight POST and is always sent. (`lib/collab/shared-run-live-publisher.ts`)
- **A tier change keeps the encoder.** The member reducer drops a frame whose `seq` is not above the current one for the same message, so a fresh encoder after `409 tool_detail_stale` would be ignored. The run keeps its encoder; the re-projected parts have new identities, so the next frame replaces every part from index 0.
- **`afterRevision` is the final correction's sequence minus one.** `settledReplyCaughtUp` lets a settled reply go once the timeline revision is greater than `afterRevision`. A member's revision is its sync cursor, the last sequence it applied.
- **A cut never splits a placeholder.** `translateOffsetsThroughRedaction` gained an opt-in `snap` that moves an offset inside a redacted span to the placeholder's edges. Without it, a placeholder shorter than its original made an inside offset look like it was after the placeholder.
- **A text part quoting a URL credential is withheld whole.** The PII gate deliberately refuses `user:<placeholder>@` even after redaction (pinned in `packages/redact`). The unbounded-opener hold ignores a URL credential the redactor already took, so the rest of the reply is not held behind it.
- **The member's freshness rules are frames.** The silence, redaction, run-end, ended-reply and socket-close rules live in `lib/collab/shared-live-frames.ts` and act by refusing frames or emitting the codec's own `reset`. `useTranscriptLiveTurn` and the codec are reused unchanged, and `withLiveReply` is the one tail rule for the paired transcript and shared members.
- **An absent `toolDetailRevision` is accepted.** An executor older than D18 shares no tool input at all, which is stricter than `summary`.
- **The composer is unchanged.** While a live reply streams, the member's message list shows it as streaming. A member's send while another member's lease is active still queues on the server, as before.
- **One live-frame contract.** The Host bridge (`cognia-companion`), the collaboration server and the TypeScript codec each check their admission rules against `protocol/transcript-live-frame-v1.json` (ids at most 256 UTF-16 units, safe integers, 200 KiB). Review 4 found the new server copy had drifted to 512.
- **Egress never waits on the network under the tombstone lock.** A live frame is checked against the session's redacted set under the lock, then sent after the lock is released, with a 5 s send timeout that closes a stalled socket. Ordering still holds, because each socket's loop sends sequentially: a frame that passed the check goes out before that same loop can send the redaction, and members refuse frames for a redacted message.
- **Members learn run boundaries from pulls too.** A run that started while a member's socket was down is announced only by the reconnect's pull, so the registry reads every pulled event, not only socket notices.
