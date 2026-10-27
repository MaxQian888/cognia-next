# Shared run live projection and share-from-now-on (ADR-0241)

**Status:** Draft — grilled 2026-10-26; adversarial reviews 1 and 2 (Codex `gpt-6.1-sol` high) applied, see §5 and §5b. A third review of the live transport (WP1–WP4) runs before those packages start.
**ADR:** `docs/content/docs/en/adr/0241-a-shared-run-streams-to-its-members.md`
**Origin:** a claude-share × Cognia comparison. It was checked against source on 2026-10-26 by four code searches and a Codex `gpt-6.1-sol` study of claude-share at `f713f4b`. Where the comparison was wrong (it proposed a canonical event stream), the ADR records why.

## 1. Decisions (grilled with the user)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Scope.** This round covers P0 (shared run live projection) and share-from-now-on. Previews for session members, executor transfer to an always-on Host, team sharing and Room UI are out; each gets its own ADR.                                                                                                                                                                                                                                                                                                             |
| D2  | **Process.** Write the ADR and this plan, run an adversarial review on Codex `gpt-6.1-sol` (high), then implement.                                                                                                                                                                                                                                                                                                                                                                                                             |
| D3  | **WP0 first.** Fix the three defects first, each behind a failing test written before the fix.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D4  | **Live channel.** Reuse the `live-frames.ts` codec (patches + 2 s keyframes). Do not stream canonical events.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D5  | **Fidelity.** A per-tool input allowlist for built-in tools and their external-agent equivalents. Reasoning is not shared. Images and files keep going through FileSpace. **Revised after review 1:** the default tier is `summary`; `full` is an owner/maintainer opt-in per shared session (D18).                                                                                                                                                                                                                            |
| D6  | **"From now on" context.** A fresh shared branch, plus an optional background summary that the owner edits and confirms. The private history stays private.                                                                                                                                                                                                                                                                                                                                                                    |
| D7  | **Upload.** Run-token `POST …/runs/{run}/live`, about 4 Hz (250 ms interval, 2 s keyframe). Broadcast only, never stored.                                                                                                                                                                                                                                                                                                                                                                                                      |
| D8  | **Compatibility.** A `cognia.chat.v2` subprotocol. A v1 socket never receives a live frame.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D9  | **Streaming redaction.** Hold back the unfinished tail: the live text stops at the last whitespace or newline. Not held back once longer than 200 chars. **Superseded by review 1 (R1):** one stateful secret boundary covers both live frames and in-progress stored corrections. An unclosed secret (PEM, JWT, credential run) stays withheld and is never released raw. **Superseded again by review 2:** whole-message redaction with a W = 256 char trailing window (user confirmed 2026-10-26; about 1–2 s of live lag). |
| D10 | **PII failure.** That part becomes a withheld placeholder. The rest of the reply publishes, and the owner keeps the original.                                                                                                                                                                                                                                                                                                                                                                                                  |
| D11 | **Stored cadence.** On settle, plus at most every 10 s while streaming. An executor on a server without live support keeps 1 s. Live support is the `/health` feature `shared-chat-live-v1` (R8).                                                                                                                                                                                                                                                                                                                              |
| D12 | **Summary source.** An AI draft from the existing summarize-then-branch path (PII-gated). The owner edits it and confirms.                                                                                                                                                                                                                                                                                                                                                                                                     |
| D13 | **Share dialog.** One dialog, two choices, default "from now on". The private row links to its shared branch.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D14 | **Team conversations.** Still refused in both modes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D15 | **Tool allowlist.** Built-in tools plus their Codex/Pi/OpenCode equivalents. MCP and plugin tools keep only the name and the redacted output.                                                                                                                                                                                                                                                                                                                                                                                  |
| D16 | **Acceptance.** A separate collab-server instance (not the shared `~/p6f` rig), two browser members, and real DeepSeek v4.1 flash through the aiden proxy at `http://127.0.0.1:8787/v1`.                                                                                                                                                                                                                                                                                                                                       |
| D18 | **Tool detail tier.** Each shared session has a server-side `toolDetail` setting, either `summary` (default) or `full`. Only an owner or maintainer can change it, and turning it on shows a risk warning.                                                                                                                                                                                                                                                                                                                     |

- `summary`: tool name; workspace-relative path(s); diff stats (+/- lines, files) for edits, writes and patches; host only for a fetch URL. Commands, patterns, queries, edit bodies and todo text are not shared.
- `full`: the D15 allowlist, with redaction and the secret boundary.
- The executor reads the tier when the run starts and again on every `member.updated` policy frame. A change applies from the next publication; it does not rewrite earlier records.
- **Review 2 (R2-1).** `member.updated` is a never-stored frame, and an executor whose socket dropped would miss it. So every stored correction and live frame carries the `toolDetailRevision` it was projected under, and the server refuses a publication whose revision is older than the session's (`409 tool_detail_stale`). The executor then re-reads the session, drops its memo, re-projects and sends a keyframe. Test: socket down, owner downgrades `full` → `summary`, HTTP still up → the next publication is refused and re-sent as `summary`. |
  | D19 | **R3 (foreign continuation WIP).** Not touched while uncommitted. Once it lands, WP0 persists the request identity and the immutable terminal payload in the run journal before the first send, and adds a recovery test for "terminal accepted, restart before release". |
  | D17 | **Delegation.** Codex `gpt-6.1-sol` writes the Rust collab-server work. Claude writes the TypeScript, UI and i18n, and gates quality. Explore searches run on haiku. |

## 2. Facts this plan stands on

All paths are relative to the repo root. Line numbers are as of 2026-10-26.

- **The publisher** is `lib/collab/shared-run-coordinator.ts`.
  - `:665-672`: a 1 s `schedule(…)` calls `publishSharedSessionRun` (`:761-837`).
  - `sessionMessages` (`:248-256`) merges Dexie messages with the live chat-store messages; live wins on id.
  - `sharedAssistantParts` (`:707-754`) keeps text (redacted) and tool parts (`input: {}`, output as a redacted JSON string). It drops everything else and throws on a PII hit.
  - `:835` chains passes with no in-flight guard.
- **The member sync** is `lib/collab/shared-chat-sync.ts`.
  - `connectSharedSessionStream` (`:677`) calls `refresh()` on every socket message (`:759-761`), and the refresh pulls over HTTP.
  - `projectEvents` (`:185`) writes Dexie.
  - `ensureLocalProjection` (`:147-182`) creates a `shared:` row of `kind: "direct"`.
- **The member render path:**
  1. `hooks/chat/use-sessions.ts:413` reacts to `collaboration.syncCursor`.
  2. `listMessages` loads the messages.
  3. The chat store receives them.
  4. `ChatMessages` (`components/chat/chat-view.tsx:1266`) renders them through `MessageList`.
  - Nothing on the member side ever sets a streaming status.
- **The server** is `crates/cognia-collab-server/src/chat_api.rs`.
  - `append_run_event` (`:2228-2318`) validates the run token, `visible_session` and `StartRun`, persists, and broadcasts.
  - `stream_events` (`:1723`) accepts only the subprotocol `cognia.chat.v1`.
  - `stream_loop` (`:1760-1811`) re-checks visibility per event and every 5 s. It closes on `Lagged`, applies no redaction projection, and ignores inbound frames.
  - `policy_event` (`:1182-1196`) is the existing never-stored `member.updated` frame with sequence 0.
  - `ChatHub.channels` (`:77-81`) is a `Channels<String, SessionEvent>` with capacity 256 (`socket_hub.rs`).
- **The codec** is `lib/chat/transcript/live-frames.ts` (encoder, `applyTranscriptLiveFrame`, `isTranscriptLiveFrame`).
  - The encoder diffs by **part object identity**.
  - Its consumers are `hooks/chat/use-transcript-live-turn.ts` and `lib/chat/transcript/live-turn-view.ts` (`withLiveTurn`, `settledReplyCaughtUp`).
  - Its only transport today is the person bridge (`crates/cognia-companion/src/ws_bridge.rs:1340-1361`, `person_chat.rs:113`).
- **The shared session's create path** is `createSharedSession` (`lib/collab/client.ts:954`). It already takes `importing?`, and the server sets status Active when `importing` is false (`chat_api.rs:444-477`). The only caller is `convertLocalSessionToShared` (`lib/collab/shared-chat-conversion.ts:285`, `importing: true`).
- **Summarize-then-branch:**
  - `lib/chat/branch-session.ts`: `BranchMode = "direct" | "summary"`, `branchSessionAtMessage`.
  - `lib/ai/generation/summarize-material.ts`: `summarizeMaterial` is PII-gated and returns typed outcomes.
  - `lib/ai/generation/summarizer.ts`: `CONVERSATION_SUMMARY_PROMPT` is a Prompt Center slot.
  - The UI is `components/chat/branch-dialog.tsx`.
- **What tool cards read:**
  - `lib/chat/tool-summary.ts` (`summarizeToolCall`, `normalizeToolName`, `bareToolName`) knows the per-tool fields.
  - `lib/execution/run-activity.ts` has `safeToolActivityMetadata`, `pathInput` and `workspaceRelativePath`.
  - Cards: `components/chat/message-parts/{terminal-tool-part,file-tool-part}.tsx`, `mcp-renderers/{edit-card,apply-patch-card,read-card}.tsx`.
- **Shared-tree WIP.** Another session has uncommitted edits in `lib/collab/shared-run-coordinator.ts`, `shared-chat-sync.ts`, `shared-chat-conversion.ts` (+ tests) and `components/chat/chat-view.tsx`. These are continuation metadata (`chatTurnOutcome`) on `run.completed`/`run.failed`. Build on top of them and commit only our hunks (the hunk recipe in `shared-tree-hunk-staging` memory).

## 3. Work packages

Each package lands with co-located tests (Hard Rule 3). The TS packages are Claude's; the Rust packages are Codex's (`gpt-6.1-sol`, high, disk watchdog on). Order (revised by review 1): WP0 → WP5 (share from now on ships on its own, still on the 1 s cadence) → WP1 ∥ WP2 → WP3 → WP4 → WP6 → WP7. The live transport is a separate landing.

### WP0 — defects (tests first)

1. **Rust (Codex): redaction on the stream.**
   - `stream_loop` keeps a per-socket redacted-id set. It is seeded from `redacted_message_ids` at upgrade and updated when a `message.redacted` event passes.
   - Each forwarded event goes through `project_redacted_events`.
   - Test: subscribe; redact; append a run correction to the redacted target. The socket must never carry the raw body.
2. **Rust (Codex): refuse corrections to redacted targets.** In `append_run_event` and in member `append_event`, a `message.corrected` whose target is redacted gets `409 message_redacted`. Tests in `chat_api.rs`.
3. **TS: in-flight guard.**
   - `publishSharedSessionRun` returns the current promise while a pass runs, and marks one trailing pass as requested.
   - `finishSharedSessionRun` still awaits the final pass.
   - Test: a server that takes 3 s → exactly one pass in flight plus at most one trailing pass.
4. **TS: PII failure → withheld part** (the shape is from WP2, introduced here).
   - Test: one message with a PII hit in one part. The other parts publish, later messages still publish, and a diagnostic is recorded.

### WP0.5 — R3 recovery fix (TS, after the foreign continuation WIP lands)

- `SharedRunJournal` gains `requestMessageId` and `terminalPayload`. `finishSharedSessionRun` builds the payload once, journals it, and only then appends the event. `recoverSharedSessionRun` replays the journaled payload byte for byte.
- Tests:
  - terminal accepted, then restart before release → recovery replays the same payload; no `operation_id_conflict`; the lease is released; the journal is deleted.
  - An old journal without `terminalPayload` is handled by rebuilding the payload from the stored request message; when that fails, the run finishes `status`-only under a new `operationId` suffix.

### WP1 — server live channel (Codex)

- **Route.** `POST /v1/orgs/{org}/chat/sessions/{session}/runs/{run}/live` (match the existing run-event route prefix).
  - Requires the shared-chat protocol header and `x-cognia-run-token`.
  - **Admission (R4).** The run-token, holder-standing and `StartRun` checks of `append_run_event` are not the whole write gate. The rollout admission, `SharedChatExecution` + `SharedChat` `Requirement::Write`, runs only inside `append_session_run_event` (`chat_store.rs:1412-1413` memory, `:2980-2981` Postgres). Add one internal store helper, `admit_run_write(tx, input, requirements)`, to both stores. It takes the open transaction/lock and the event's own requirements, and runs the lease query, holder standing and the given rollout admissions. `append_session_run_event` keeps calling it with `event_requirement(&input)` and atomically inserts (terminal `run.*` stays `ContractOnly` at `chat_store.rs:604-609`, so an emergency stop still lets a run finish and release). The live route calls it with `SharedChatExecution` + `SharedChat` `Requirement::Write` and inserts nothing (review 2, R2-4). There is no cache: at ≤ 4 Hz per run the queries are cheap, and a cache would let an emergency stop or a read-only switch lag.
  - Body cap 256 KiB. Shape check mirrors `isTranscriptLiveFrame`.
  - `messageId` must be the target of a `message.created` whose `actor_id = run:{run}`. Keep an in-memory per-run set, filled by `append_run_event`; fall back to `get_message_event` on a miss.
  - Refuse a redacted target. Answer `204`. Never persist.
  - **Egress tombstone (R2, revised by R2-5).** Upload checks cannot stop a frame already queued on the live channel when a `message.redacted` lands. A per-socket "seen" set is not enough: when both channels are ready, `select!` may pick the live frame before the redaction event (`chat_api.rs:1770-1794`). `ChatHub` therefore keeps one authoritative per-session redacted set. The redaction's append inserts into it **before** broadcasting, under the same lock the live egress takes to check it. A live frame is checked against that set at send time. Test: redaction committed, socket has not consumed the event yet, queued live frame → not sent.
- **Tool detail setting (D18).** `tool_detail` (`'summary'` default, `'full'`) and `tool_detail_revision` columns on shared sessions, added in a migration for both stores. `append_session_run_event` (for `message.*`) and the live route refuse a `toolDetailRevision` below the current one. Set through the existing session update route; only `owner`/`maintainer` may change it. Returned on the session read, bumps `policy_revision`, and broadcasts `member.updated`. Tests: role refusal, default, both stores.
- **Hub.** `ChatHub` gains a second `Channels<String, LiveFrame>` (small capacity, e.g. 32). A lag on it means skip, not close.
- **Socket.**
  - `stream_events` accepts `cognia.chat.v2` (preferred when offered) or `cognia.chat.v1`.
  - A v2 `stream_loop` sends `{type:"event",event}` and `{type:"live",frame}`, and subscribes to the live channel. v1 behaviour is byte-for-byte unchanged.
- **Standing.**
  - Live frames are forwarded only while a per-socket standing check is fresh: refreshed ≤ 1 s before, and immediately after a `member.updated` frame for the session.
  - Stored events keep their per-event check.
- **Capability (R8).** Do not touch `/capabilities`: its `features` are typed `FeatureDecision`s locked by `protocol/collab-capabilities-v1.json`, and the client drops unknown keys (`lib/collab/capabilities.ts:37-43, 150-153`). Instead `/health` pushes `shared-chat-live-v1` next to `shared-chat-execution-v2` (`api.rs:348-352`). The coordinator already reads `client.health()` when a run starts (`shared-run-coordinator.ts:507`). Update `CollabHealth` parsing and its test.
- **Tests:**
  - token/lease/role refusals, foreign `messageId`, redacted target, oversize;
  - rollout switched to read-only or off while a lease is live → the next frame is refused (both stores);
  - redaction committed while a live frame is queued → the socket never sends that frame;
  - v1 socket gets no live frame; v2 socket gets both kinds;
  - lagging live receiver keeps its event stream;
  - revoked member stops receiving live frames within 1 s;
  - nothing written to `chat_session_events`.
- **Client shims.** `lib/collab/client.ts`:
  - `postSessionRunLiveFrame`;
  - `openSessionStream({ live: true })` offers v2 and hands envelopes to `onEvent` / `onLive`;
  - capability read.
- **Contract mirrors.** If the companion catalog or the collab OpenAPI copy lists these routes, update them in the same change.

### WP2 — the shared projection (TS)

- **Codec home.** Move the frame codec to a transport-neutral module (e.g. `lib/chat/transcript/live-frames.ts` stays and loses its person-only header, or the generic half moves to `lib/chat/live-reply/frames.ts`; decide by import graph). Both the person path and the shared path import it. No second codec.
- **Memo.** `sharedAssistantParts(parts, ctx)` keeps a `WeakMap<sourcePart, projectedPart>` per run. An unchanged source part returns the same projected object. Unit test: identity is stable across calls, and the encoder emits `base > 0` patches.
- **Tier switch (D18).** `sharedAssistantParts(parts, { tier, workspaceRoot })`. Under `summary` a tool part keeps the name, workspace-relative path(s) and `diffStats` (reusing the counts of `lib/connectors/activity/diff-producer.ts`), plus the URL host for fetch. Its `input` holds only those fields, so the cards fall back to their compact rows. Under `full` the allowlist below applies. The memo is keyed per tier, so a tier change produces new objects and a keyframe.
- **Tool input allowlist (`full` tier only).** One table keyed by normalized tool name, reusing `normalizeToolName`/`bareToolName` from `lib/chat/tool-summary.ts`.

  | Tool family                                       | Fields kept                                                                  |
  | ------------------------------------------------- | ---------------------------------------------------------------------------- |
  | `Bash`/`shell`/Codex `exec_command`/`local_shell` | `command`, `description`                                                     |
  | `Read`/`Write`/`NotebookEdit`                     | path, through `workspaceRelativePath` (absolute outside workspace → dropped) |
  | `Edit`/`MultiEdit`                                | path, `old_string`/`new_string`/`edits[]`                                    |
  | `apply_patch`                                     | `patch`, with each file path made workspace-relative                         |
  | `Glob`/`Grep`                                     | `pattern`, `path` (relative)                                                 |
  | `WebFetch`                                        | `url`                                                                        |
  | `WebSearch`                                       | `query`                                                                      |
  | `TodoWrite`                                       | `todos`                                                                      |
  - Every string goes through `redactText` and a per-field cap (command 2 KiB, edit strings 16 KiB each, patch 64 KiB; truncated values carry a marker). Input fields of a tool part still streaming its arguments use the same secret boundary as text.
  - MCP and plugin tools: `input: {}` as today.
  - **No safe input projector exists yet** (search 2026-10-26). Every summarizer returns raw commands, patterns and URLs, only clipped. Share-link exports emit tool inputs verbatim (`lib/export/html/beautiful-html.ts:141`). The projector is new, but it is built only from these existing parts:
    - **Name and category.** `safeToolActivityMetadata`. Export `workspaceRelativePath` / `pathInput` from `lib/execution/run-activity.ts` rather than copying them.
    - **Paths inside free text** (commands, patterns, patches). `normalizeProjectPaths` / `hasIdentifyingPath` (`packages/memory/src/extract/project-path-normalize.ts`). An identifying path that survives drops the field.
    - **URLs.** `redactCredentialUrl` (`lib/security/redact-credentials.ts`).
    - **Commands and free text.** `redactCredentialText`, then `redactText`, then the per-part `hasNoLeakingPiiDeep`.
    - **Object keys** (TodoWrite, edits[]). `isCredentialKey` (`packages/plugin-contract/src/lib/templates/contracts.ts`). Not the substring key list in `packages/logging`, which over-triggers on `max_tokens`/`sessionId`.
    - **Shell tool names.** Take the most complete list in `components/chat/decisions/tool-decision-content.tsx:58-69` (`local_shell`, `exec_command`, `run_terminal_cmd`, `run_shell_command`, …). Move it to one exported constant that the decision card, `tool-summary.ts` and the projector all import. The lists disagree today, and keying on the short one misses Codex calls.
    - **External names.**
      - Codex `shell` `{command, cwd}` / `edit` (`packages/agent-codex/src/app-server-client.ts:2727-2745`), `local_shell` `{action}` (`history.ts:681`).
      - OpenCode `shell` (`packages/agent-opencode/src/v2-events.ts:148-160`).
      - Pi bash/read/edit/write/grep/find/ls (`packages/agent-pi/src/permission.ts:22`).
      - The CLI canonical map (`cli/src/runtime/external/external-event-mapper.ts:356-366`).
    - **Privacy manifest wording.** Reuse `removedFields` from `lib/governance/producers/action-review.ts:58-66`.
  - `cwd` is never shared. Codex `edit` and other variants map onto the same field rules as their built-in counterparts.

- **Withheld part.** Run `hasNoLeakingPiiDeep` per projected part. A failing part becomes `{ type: "data-shared-withheld", data: { reason: "pii" } }`.
  - It is rendered through `renderPart` with an i18n label, in both locales.
  - Hard Rule 7: the type is documented, the UI labels it inert, and a test pins it.
- **Secret boundary (R1 → revised by review 2, R2-1…R2-3).** One general rule replaces the per-matcher opener table, because matchers keep spanning separators. The phone and bank-card patterns accept spaces (`packages/redact/src/index.ts:121, 134`), and an API key split across two text parts passes the per-string deep gate (`:858-874`).
  - **Released form.** While a reply streams, the releasable form of its text is computed over the **whole message**: every text part joined in order (SDK replies keep several text blocks, `lib/claude/adapter.ts:53-58`), never part by part.
  - **Window.** `redactText` runs over the whole joined text, and the result is cut at offset `len − W` (W = 256 chars, snapped back to whitespace). The cut point is mapped through `translateOffsetsThroughRedaction`, and the released prefix is split back into its parts.
  - **Why that works.** A match still forming sits inside the last W characters. Any secret shorter than W that crosses the cut has already started forming before it, so it is complete in the full text and redacted. A test pins W against the longest bounded matcher in `@cognia/redact`: for every `PII_KINDS` pattern except the unbounded ones, `W ≥ max match length`.
  - **Unbounded kinds (PEM, JWT, URL credentials).** From an opener to the end of the message, these are withheld whenever `redactText` has not yet redacted that span. The openers are a PEM `BEGIN` header, `eyJ`, and a `scheme://user:` prefix. The test fails if a new `PII_KINDS` entry is added without being classified as bounded or unbounded.
  - **Scope of the rule.** It applies to live frames **and** to the pre-settle stored corrections.
  - **At settle.** The whole text goes through `redactText`. Any unbounded-opener span that is still unredacted stays withheld in the record too: an unclosed PEM, a two-segment JWT, an unterminated URL credential. Settle covers completion, cancellation and truncation alike.
  - **Memo invalidation.** The memo is per message, not per part, for text. Any text change re-derives the released text of the message. Tool parts keep the per-part memo.
  - **Tool inputs.** A tool part's input is shared only once it reaches `input-available` or a later state. While its arguments are still streaming, `input` is `{}`. The finished input has no "forming" problem, so it is not windowed.
  - Tests cover:
    - every bounded matcher at every split position;
    - a key split across two text parts;
    - a multi-line PEM over many ticks;
    - a never-closed PEM, a two-segment JWT and a URL credential at settle;
    - cancellation mid-secret.
- **Workspace root.** The executor's session workspace root reaches the projector from the run's context (`resolveCurrentCollabContext` or the session row). Without a root, paths are dropped.

### WP3 — executor live publisher (TS)

- `ActiveSharedRun` gains:
  - **one active encoder per run (R7).** The member reducer holds one live reply per session: `applyTranscriptLiveFrame` replaces the current reply when a keyframe for another `messageId` arrives (`live-frames.ts:212-214`), so two interleaved encoders would flicker. When a newer assistant message starts streaming, the previous one is settled first: stored write, then its `settled` frame. Only then does the new encoder start.
  - **Review 2 (R2-6).** Live uploads are single-flight and ordered. While a POST is in flight, the next frame waits. If more than one is waiting, only the newest survives and the encoder is forced to a keyframe. A handoff drains the queue first.
  - The member also keeps a per-run set of ended message ids: settled, reset, redacted, or any message once the run's terminal event is seen. It refuses later frames for them, so a delayed keyframe cannot revive an old reply.
  - Tests: two assistant messages in one run; a delayed A keyframe after B's first frame; a late frame after the terminal event;
  - a 250 ms live tick, which projects, applies the hold-back and posts any non-null frame;
  - a stored tick, which runs on settle and on the first change ≥ 10 s after the previous stored write. It runs every 1 s when `sharedChatLive` is false.
- Settle order: final `message.corrected`, read its `sequence`, then encoder `next(parts, "settled", sequence)`. On a terminal failure, send `reset`.
- Live POST failures:
  - any 4xx other than 429 disables live for the run;
  - a 429 or 5xx drops the frame, and the next keyframe repairs;
  - none of these ever fails the run.
- Lease lost or run torn down: stop both ticks and send no further frames.
- Tests:
  - frame order and cadence with fake timers;
  - stored writes ≤ every 10 s plus settle;
  - 1 s fallback when capability is false;
  - settled carries the accepted sequence;
  - live disabled on 4xx without run failure;
  - no frames after lease loss.

### WP4 — member live view (TS + UI)

- `connectSharedSessionStream` opens v2 when the client supports it. A `event` envelope still means "pull" (unchanged invalidation semantics). A `live` envelope is checked with `isTranscriptLiveFrame` and handed to a per-session live listener registry.
- **ID mapping (R5).** Frames carry remote ids, but a member's projected message id is `${localSession.id}:message:${JSON.stringify(remoteId)}`, or the original local id on the converting device (`shared-chat-sync.ts:268-271`; the remote id lives in `collaboration.remoteMessageId`). `withLiveTurn` compares `message.id`, so before folding, map `messageId`, `replyTo` and `sessionId` to local ids. Use one exported mapping function shared with `projectEvents`, never a second formula. Test both id layouts: a fresh member device and the original converting device.
- **Freshness and teardown (R6).** The codec marks stale only on a gap, and the hook times out only a settled reply (`use-transcript-live-turn.ts:66-80`). A crashed executor sends nothing, so the overlay would stream forever. Rules:
  - A streaming reply with no frame for 6 s (three keyframe periods) is dropped.
  - On `run.completed`/`run.failed` the member stops showing the run as running and refuses further streaming frames for it. A **settled** overlay is kept until the projection's applied cursor reaches its `afterRevision`, or until the existing 10 s ceiling. That matters because the terminal notice can arrive before the HTTP pull has applied the final correction (review 2, R2-7). A still-streaming overlay at that point (no settled frame: executor crash) is kept until the next pull completes, then dropped.
  - The overlay is cleared at once on a `message.redacted` for its message (later frames for that id are refused, R2), on socket close and on session teardown.
  - The member's "running" state comes from run events and the lease, never from frame state.
- **Hook.** Generalize `useTranscriptLiveTurn`, or add a sibling, to take `subscribeLive` plus a revision. For shared sessions the revision is the projection's `collaboration.syncCursor`. Reuse `settledReplyCaughtUp` and `SETTLED_LIVE_REPLY_MAX_MS`.
- **Overlay.** In `ChatMessages` (`chat-view.tsx`), merge the live reply into the message list by id (the `withLiveTurn` tail rule, extracted as a shared helper if needed). On the executor's own device the overlay is skipped for runs it holds (`getSharedRunRequester` / the active-run map).
- **Status.** While a live reply streams, the member's chat shows the streaming indicator and the composer treats the session as running (input queues as today).
- Tests:
  - frames fold and draw;
  - no frame for 6 s → overlay dropped; redaction / socket close clear it at once;
  - terminal notice before the final correction is pulled → settled overlay stays until the cursor reaches `afterRevision`;
  - redaction arriving before a late keyframe → keyframe ignored;
  - a gap marks stale until keyframe;
  - settled drops once the cursor reaches `afterRevision`;
  - `reset` falls back to stored;
  - the executor device ignores its own run;
  - a v1 server (no v2 accepted) degrades to today.

### WP5 — share from now on (TS + UI + i18n)

- **Dialog.** Replace the single "Convert and share full history" button in `components/chat/shared-session-panel.tsx` with one dialog and a radio, default "from now on".
  - The "full history" branch keeps today's reference scan + warning dialog.
  - Team rooms stay disabled with today's copy.
- **`shareConversationFromNow(client, { localSessionId, orgId, workspaceId, attemptId, background? })`** in `lib/collab/shared-chat-from-now.ts`. It reuses the conversion module's team refusal and the feature gate; `attemptId` keeps a lost-response retry idempotent. Steps:
  1. `createSharedSession(…, { importing: false, title })`.
  2. If background was confirmed, post it as the owner's first `message.created` (`operationId` derived from the attempt). It is a plain user message whose text starts with a localized heading. A `metadata` flag would be dropped: `payloadMessageMetadata` keeps only the reference and continuation keys (`shared-chat-sync.ts:97-110`).
  3. Run `syncSharedSession` → `ensureLocalProjection` and get the `shared:` row.
  4. Set `parentSessionId = <private id>` on the shared projection row. That is the existing branch lineage, indexed since Dexie v80, so `branch-lineage-chip` and `branch-children-chip` link the two with no new field and no schema change. The private row is never written. The link exists only on the owner's device.
  5. Activate the new session.
  - Failures leave the private row untouched; a created-but-unlinked remote session is retried or deleted the same way the conversion draft is.
- **Background draft.** The branch dialog's summary step is extracted into `hooks/chat/use-conversation-summary-draft.ts` and `components/chat/conversation-summary-editor.tsx`, and both the branch dialog and the shared panel use them. The draft goes through `summarizeMaterial` with the `branch-seed` purpose. The owner may edit, redraft or clear it. Nothing is posted until they press "Start shared conversation".
- **Private-row link.** Given by the lineage chips (step 4). No new chip.
- **Tool detail switch (D18).** The members section of the shared session panel gets a toggle, "Show members commands and diffs", visible to owner/maintainer and read-only for others. Turning it on asks for confirmation with a risk warning.
- **i18n.** Every new string goes into `i18n/messages/{en,zh-CN}/chatCollaboration.json`, then `pnpm i18n:build`.
- Tests:
  - no private message or attachment is uploaded;
  - background posted only on confirm;
  - link written and cleared;
  - team refused;
  - the dialog defaults to "from now on";
  - the full-history path is unchanged.

### WP6 — docs and changeset

- ADR-0241 en + zh, added to both `meta.json`s, with status → Accepted after WP7.
- ADR-0149: an implementation update pointing at ADR-0241.
- `docs/plans/2026-08-29-server-authoritative-shared-ai-chat.md` §4 and `:61`: correct "WebSocket owns low-latency increments" to the cursor-invalidation reality plus ADR-0241's live channel.
- ADR-0177: a one-line note in the implementation log that the `shared` kind now streams (no change to "Later").
- The subsystem doc page for shared chat, if one exists (find it; if none, the ADR suffices).
- `pnpm changeset` (`cognia-next`, minor): "Shared conversations stream the agent's reply live to members, show tool commands and diffs, and can be shared from now on without their history."

### WP7 — verification

- **Unit / Rust.**
  - `pnpm test -- lib/collab lib/chat/transcript hooks/chat components/chat/shared-session-panel` (targeted, `--runInBand`).
  - `cargo test -p cognia-collab-server` (port-binding tests outside the Codex sandbox).
  - The Postgres store tests against the local `postgres:16` image (`collab-postgres-tests` memory).
- **Real two-member smoke (D16).**
  - A fresh collab-server on its own port and database (not 18081 / `p6f-pg`).
  - Two fresh browser contexts signed in as two org members.
  - Member A shares from now on (with a background), invites B, and asks for a turn that runs Bash and edits a file on DeepSeek v4.1 flash.
  - Capture B's v2 frames (CDP `Network.webSocketFrameReceived`). Check:
    - frame cadence;
    - the tool card shows the command and diff;
    - no secret prefix appears;
    - a v1-only client sees 10 s steps;
    - kill A's network mid-turn → B goes stale and recovers from the stored log;
    - revoke B → frames stop within 1 s;
    - Postgres has no live rows.
- **Gates.** `pnpm preflight` fan-out, then `pnpm typecheck`, `pnpm lint`, `pnpm lint:i18n`, `pnpm i18n:build:check`, `pnpm audit:colocated-tests`, `pnpm audit:rust-architecture`, `pnpm docs:build`, the collab OpenAPI/companion contract checks if touched. Paste the outputs verbatim.

## 4. Risks to review adversarially

1. **Hold-back vs. redaction rules.** The hold-back covers secrets that grow at the tail. It does not cover a regex that only matches once a later token arrives far from the tail (e.g. a multi-line PEM). Is the 200-char ceiling safe for PEM/JWT blocks, or should an open `-----BEGIN` hold until `-----END`?
2. **Tool input exposure.** Commands and edit bodies can contain secrets that `redactText` misses (custom env names, internal hostnames). `redactText` and `hasNoLeakingPiiDeep` are PII-only: passing them does not make a command shareable.
   - Compare with the share-link export, which ships tool inputs verbatim but only to readers the owner chose and only as a snapshot.
   - Compare with what members could already read in redacted tool output.
   - Should edit bodies (`old_string`/`new_string`, Write `content`) be shared at all, or only as diff stats (`lib/connectors/activity/diff-producer.ts` counts)?
3. **Lease-check cache.** A ≤ 1 s cache means a just-revoked executor can publish for up to a second. Is that acceptable next to the 90 s heartbeat TTL that already bounds it?
4. **10 s stored cadence.** On an executor crash, members lose up to 10 s of reply that live frames showed them. Recovery re-runs nothing, so the reply ends truncated in the log.
5. **v2 envelope versioning.** A future v3 must not break v2 clients. Unknown envelope `type`s are ignored.
6. **"From now on" summary.** The background is model output about private history, posted under the owner's name. The confirm step is the control; make sure the draft never auto-posts on dialog dismiss.
7. **Concurrent WIP.** Another session is editing the same three collab modules.

## 5. Adversarial review 1 (Codex `gpt-6.1-sol`, high, 2026-10-26)

The review's verdict was **needs-attention**. Every finding was re-checked against source before it was accepted.

| #   | Sev  | Finding                                                                                                                                                                                                                                                                                                                                                                    | Verified at                                                                  | Resolution                                                                                                                                                                            |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | high | The whitespace hold-back releases an unclosed private key. A PEM matches only when closed, so an unfinished one passes the PII sweep, and the 200-char ceiling releases half-written JWTs. Hold-back only on live frames means the 10 s stored corrections still write the secret.                                                                                         | `packages/redact/src/index.ts:327-337`                                       | WP2 secret boundary, shared by live and pre-settle stored writes. Never released raw.                                                                                                 |
| R2  | high | A live frame queued before a redaction can redraw the redacted message: the two channels interleave, and `withLiveTurn` re-adds `live.parts`.                                                                                                                                                                                                                              | `shared-chat-sync.ts:327-345`, `live-turn-view.ts:59-75`                     | WP1 egress tombstone per socket; WP4 clears the overlay on redaction and refuses later frames for that id.                                                                            |
| R3  | high | The **uncommitted continuation WIP** (another session) makes the terminal payload depend on `requestMessageId`. `persistRun`/`SharedRunJournal` do not store it, so a restart between the accepted terminal event and lease release replays a different payload under the same `operationId`. The server answers `operation_id_conflict`, and recovery has no retry timer. | `shared-run-coordinator.ts:147-156, 859-892`; `chat_store.rs` `replay_event` | Not in this plan's diff. See §6: it must be fixed before or with WP0, because the journal must persist the request identity and the immutable terminal payload before the first send. |
| R4  | high | The live route skipped the rollout admission (`SharedChatExecution`/`SharedChat` write), which only runs inside `append_session_run_event`. A read-only or off switch would not stop frames.                                                                                                                                                                               | `chat_store.rs:1412-1413, 2980-2981`                                         | WP1 `admit_live_frame` in both stores, shared with append. No cache.                                                                                                                  |
| R5  | med  | Frame ids are remote, but member message ids are local (`<session>:message:"<remote>"`), so the overlay would duplicate the reply.                                                                                                                                                                                                                                         | `shared-chat-sync.ts:268-271`                                                | WP4 one shared remote→local id mapping.                                                                                                                                               |
| R6  | med  | A silent executor leaves the overlay streaming forever. Only gaps mark stale, and only settled replies time out.                                                                                                                                                                                                                                                           | `live-frames.ts:219-220`, `use-transcript-live-turn.ts:66-80`                | WP4 6 s freshness deadline, plus clearing on terminal, redaction, close and teardown. Running state comes from run events and the lease.                                              |
| R7  | med  | One encoder per assistant message does not fit a single-reply member reducer: interleaved keyframes flicker.                                                                                                                                                                                                                                                               | `live-frames.ts:212-214`                                                     | WP3 one active encoder; settle the previous message before starting the next.                                                                                                         |
| R8  | med  | `/capabilities` features are typed decisions locked by `protocol/collab-capabilities-v1.json`, and the client drops unknown keys. A `sharedChatLive` boolean would never reach the executor.                                                                                                                                                                               | `capabilities_api.rs:20-27`, `lib/collab/capabilities.ts:37-43, 150-153`     | Use the `/health` transport feature `shared-chat-live-v1` (`api.rs:348-352`), which the coordinator already reads (`shared-run-coordinator.ts:507`).                                  |

The review also gave two pieces of advice. Both ran against earlier decisions, so they went back to the user (§6):

- **Delivery order.** Land WP0 and share-from-now-on first on the 1 s cadence, and the live transport separately. Adopted as the WP order above.
- **Tool inputs.** By default share paths and diff stats only. Raw commands and edit bodies would need explicit authorization: passing pattern redaction is not the same as being shareable.

## 5b. Adversarial review 2 (same thread, 2026-10-26)

The verdict was again **needs-attention**. R3, R5 and R8 were confirmed closed. The new findings were each checked against source and accepted:

| #    | Sev  | Finding                                                                                                                                                              | Resolution                                                                                                                                                                                               |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | high | A D18 downgrade relies on a never-stored `member.updated` frame. An executor whose socket dropped keeps publishing `full`.                                           | Publications carry `toolDetailRevision`; the server refuses stale ones with `409`. Executor re-reads, re-projects and sends a keyframe.                                                                  |
| R2-2 | high | Phone and bank-card matchers span spaces (`redact/index.ts:121, 134`), so an opener table released them digit group by digit group.                                  | Window rule (W = 256) over the redacted whole text, pinned by a test against every bounded matcher's max length.                                                                                         |
| R2-3 | high | Boundary state was per part: a key split across two text parts passed the deep gate. Only an unclosed PEM was kept at settle.                                        | The window works on the whole message's joined text. At settle every unbounded-opener span (PEM, JWT, URL credential) still unredacted is withheld. Tool inputs are shared only after `input-available`. |
| R2-4 | high | Sharing a double-Write admission with append would block terminal `run.*` (`ContractOnly`, `chat_store.rs:604-609`) under an emergency stop, so no run could finish. | `admit_run_write(tx, input, requirements)`: append passes the event's own requirements, live passes both Writes.                                                                                         |
| R2-5 | med  | A per-socket seen-tombstone loses the race when `select!` picks the live frame first.                                                                                | A session-level tombstone in `ChatHub`, inserted before the redaction broadcasts, checked at live egress under the same lock.                                                                            |
| R2-6 | med  | In-flight POSTs can deliver a stale keyframe after a handoff, and the reducer accepts another message's keyframe.                                                    | Single-flight ordered upload; drain before handoff; member refuses frames for ended message ids.                                                                                                         |
| R2-7 | med  | Clearing the overlay on `run.completed` drops the final reply before the pull applies it.                                                                            | Keep the settled overlay until the cursor reaches `afterRevision` (or 10 s); terminal only stops "running" and refuses new streaming frames.                                                             |

## 6. Open after review 1

Both items were decided by the user on 2026-10-26:

- R3 → D19 / WP0.5. The fix waits for the foreign WIP to land, then WP0.5 takes it.
- Tool inputs → D18. `summary` by default; `full` is opt-in per session.

## 7. Progress (2026-10-26)

| WP               | State        | Where                                                                                                                                                                      |
| ---------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP0              | done         | `lib/collab/shared-run-coordinator.ts` (withheld parts, redacted ids, single-flight publish), collab-server tombstone + `409 message_redacted`                             |
| WP0.5            | waiting      | on the other session's continuation WIP (D19)                                                                                                                              |
| WP1 + D18 server | done (Codex) | live route, `admit_run_write`, v2 envelopes, egress tombstone, `/health` `shared-chat-live-v1`, migration 0018; `cargo test` 360 + 3 pre-existing failures, Postgres 36/36 |
| WP2              | done         | `lib/collab/shared-assistant-projection.ts`, `translateOffsetsThroughRedaction({ snap })`, `file-tool-part` diff stats                                                     |
| WP3              | done         | `lib/collab/shared-run-live-publisher.ts`, coordinator wiring (250 ms live tick, 10 s stored cadence, settle `afterRevision`, tier refresh)                                |
| WP4              | done         | `lib/collab/shared-live-frames.ts`, `hooks/chat/use-shared-live-reply.ts`, `withLiveReply`, `ChatMessages` overlay, v2 in `connectSharedSessionStream`                     |
| WP5              | done         | share from now on + `SharedToolDetailSetting`                                                                                                                              |
| WP6              | done         | ADR-0241 implementation notes, ADR-0149/0177 updates, subsystem page, 2026-08-29 plan correction, changeset                                                                |
| WP7              | pending      | real two-member smoke; status flips to Accepted after it                                                                                                                   |

Refinements made while building are in ADR-0241 "Implementation notes".
