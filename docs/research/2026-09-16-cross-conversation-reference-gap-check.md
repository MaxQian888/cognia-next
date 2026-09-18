# Cross-Conversation Reference ("引用任务对话") — Gap Check Against markone Design Doc (2026-09-16)

## Scope and evidence standard

This note compares the markone design doc **引用任务对话** (reference an existing
task/conversation A from inside conversation B via an `@` picker, inject a versioned,
permission-checked snapshot into B's context, and keep the reference alive across
send/replay/history) against Cognia's implementation. It is a code-grounded audit, not a
feature proposal.

- Reference doc: `https://bytedance.larkoffice.com/wiki/Dz9zwQPmoiLb75kqYz8cTNpznAb`
- Cognia baseline: commit `1afd84eaf05c846a03adbd4a5aeb0f2197c90315` plus the local
  working tree on `2026-09-16` (the two unrelated dirty files — `cli/src/cli/run-command.ts`,
  `lib/ai/agent/external/manager.ts` — do not touch any audited path).
- Review method: every claim below was verified against source and, where load-bearing,
  re-read a second time after drafting. Line numbers refer to the working tree above.

Evidence labels:

- **Covered** — Cognia already implements the gap the doc describes.
- **Partial** — the mechanism exists but one or more paths/edges drop it.
- **Gap** — missing; same failure shape the doc warns about.

## Executive readout

Cognia is **not missing the feature**. The doc's core model already ships under ADR-0157
(accepted 2026-08-29):

- `@chat:` references an entire conversation, `@msg:` a single message; multi-select
  message sets, `@prompt:`, `@result:`, `@artifact:`, `@memory:`, `@issue:` also exist.
  Entity kinds are enumerated in `types/artifact/artifact.ts` (`EntitySelectionRef`,
  `ContextSelectionRef`, `EntityReferenceMember`).
- Sources are a uniform registry in `lib/chat/mentions/entity-sources.ts`; staging runs
  through `hooks/chat/use-entity-mention-staging.ts`, which freezes a snapshot and an
  optional fingerprint at chip-creation time.
- The snapshot is injected as a `<cognia_context_…>` envelope written **into the persisted
  user-message text** (`lib/chat/prompt-preamble.ts`), and structured identity rides as
  `metadata.mentions: ContextRef[]` + `metadata.promptPreamble` on the message row.
- A Dexie backlink index (`lib/db/mention-links.ts`) keeps one row per
  `(message, reference)`, reconciled after edits/truncations via
  `lib/db/chat-search-text.ts`.
- Snapshots from another record are wrapped by `wrapUntrustedRecord`
  (`entity-sources.ts:302-329`) — the prompt-injection frame the doc asks for.

The structural divergence from the doc: **the envelope inside message text is the only
guaranteed carrier.** Every transport delivers the snapshot _content_ (it is part of
`text`), but `metadata.mentions` / `metadata.promptPreamble` / `contextSelections` travel
on per-path side channels — and four channels never got the fields. The result matches
the doc's worst warned-about failure: the model sees the referenced material, while the
persisted row claims nothing was referenced, so backlinks, stale markers, and reference
identity silently vanish.

## Gap-by-gap comparison

### G1 — Reusable mention source for task/conversation selection (both entry points) → Covered

- All five chat surfaces (desktop, mobile shell, Inbox IM, workbench, workflow copilot)
  mount the same `components/chat/composer.tsx`; `entity-sources.ts` is the single
  source registry.
- Command palette (`⌘K`) stages the identical chip through
  `lib/chat/composer-reference-request.ts` (`COMPOSER_REFERENCE_REQUEST_EVENT`), whose
  contract is explicitly "structured staging, not a textual `@name`" (comments at
  `composer-reference-request.ts:5-17`).
- New-conversation composer is the same component; `callOptions.citations` exists
  precisely because cited refs cannot be read back from a session that does not exist
  yet (`components/chat/composer.tsx` send block, ~:3615-3734).

### G2 — Mentions must become persisted model inputs, not `@title` text → Covered

- `metadata.mentions: ContextRef[]` + envelope-in-text are stamped together in
  `hooks/chat/use-claude-chat-controller.ts:1329-1347`.
- `lib/chat/mentions/read.ts` validates with `isContextRef` and falls back to legacy
  text parsing, so old rows still resolve.
- Snapshots freeze at staging; later source drift marks `stale` rather than silently
  re-reading — the exact semantics the doc lands on.

### G3 — Platform/SDK agreement on a structured reference type → Mostly covered

- `ContextRef`, `EntitySelectionRef`, `PromptPreambleSummary` are shared types consumed
  by composer, controllers, room runner, and mention-link indexer.
- One residual: the envelope itself is versionless opaque text — no schema field
  protects against a future format change (minor; noted for completeness).

### G4 — Every send path shares the snapshot/parse contract → Partial — the real gap cluster

Correct paths:

- Direct send, edit-and-resend (`carryPromptPreamble` + `chipCitationsOf`,
  `use-claude-chat-controller.ts:4055-4070`), and regenerate (replays
  `lastSendBySession`) all preserve envelope + citations.
- Room runner stamps `metadata.mentions`/`promptPreamble` on both normal sends and
  queued steer rows via `referenceMetadata` (`lib/chat/room/runner.ts:395`, `:488`,
  `:1731-1736`), and room edit/resend re-carries them (`:839-849`).

Broken paths:

- **Direct-chat steer (live + queued).** The steer branch at
  `use-claude-chat-controller.ts:852-957` returns _before_ the mention-merge block at
  :1329; the optimistic row gets only `metadata.steer`. `SteerEntry` is
  `{id, text, blocks?, webSearchContext?, replyTo?}` (`stores/chat/chat-store.ts:34-42`)
  — no citations field. On replay, `steerDrain` triggers `skipAppend` (:1378): the merge
  block still runs, but the `userMsg` it produces is discarded. Net: a steered
  `@chat:` message lets the model read the snapshot, yet the persisted row has no
  mentions → no backlink, no preamble summary.
- **Shared sessions — worse than first assessed.** The `send` shared branch
  (:792-830) returns before the merge and calls `sendSharedSessionMessage`; the
  `message.created` event payload is `{messageId, role, parts, createdAt, author}`
  (`lib/collab/shared-run-coordinator.ts:407-416`); `lib/collab/shared-chat-sync.ts`
  contains no `metadata` handling anywhere. So the **sender's own local row** also
  lacks `metadata.mentions` — in a shared session backlinks are blind for every member,
  not just remote ones.
- **Companion `room_send` RPC.** `RoomSendRequest` has no `citations`/`promptPreamble`
  (`lib/companion/room-send-client.ts:22-38`); the host handler neither reads nor
  forwards them (`lib/companion/room-write-handlers.ts:159-170`). The companion's
  optimistic row carries metadata but the sync mirror row replaces it.
  Additional finding: `referenceMetadata` only honors `opts.citations` — it never runs
  `resolveMentions` over typed `@` text (`runner.ts:1731-1736`), so a hand-typed
  `@file` in a team room also misses `metadata.mentions`.
- **Host-state intents (paired/remote devices).** `message.enqueue`, `turn.steer`,
  `turn.followup` carry `text` + `attachments` only
  (`packages/agent-config-types/src/host-state.ts:115-133`); the host-materialized row's
  metadata is `{hostState:{…}}` only (`lib/sync/host-state-service.ts:794-801`).

### G5 — Queue codecs must not silently drop new variants → Partial (lighter form)

Not a lost union variant, but the four closed shapes above each lack the field; the
envelope in `text` keeps the _content_ alive while the _structure_ drops — the same
failure shape the doc flags.

### G6 — Layered permission checks (list / preview / send / queue / re-read) → Partial

- Listing/reading side is sound: `filterExposedSessions("global-search")` + project-scope
  filtering gate candidates; on revocation `purgeRevokedSharedSession` wipes the local
  mirror (`shared-chat-sync.ts:333-358`), so a fresh snapshot returns `null` and staging
  is blocked by toast.
- **Missing audience check:** `sendSharedSessionMessage` and session→shared conversion
  publish `parts` verbatim; a private-session snapshot embedded in the text crosses the
  boundary with no prompt or warning.
- The doc's optional "block send when the source is deleted/revoked" does not exist;
  Cognia deliberately keeps the frozen copy and marks `stale` (ADR-0157 decision) — a
  product-difference to surface, not a bug.

### G7 — Authoritative complete history read → Partial (deliberate design)

- Reads come from Dexie, not the DOM/sidebar — the doc's requirement is met in shape.
- `projectSearchText` strips nested envelopes (`lib/chat/search/project-text.ts:134-139`),
  so referencing A from C does not re-import B's snapshot embedded in A — subtler than
  the doc requires.
- But `@chat:` snapshots are a **bounded tail**: `MAX_TRANSCRIPT_MESSAGES = 40`, tool
  output dropped, with a truncation banner (`lib/chat/mentions/entity-transcript.ts`).
  If the product promise is "the whole task context", that bound is a real difference
  to put on the table.

### G8 — Drafts and time-travel preserve references → Partial

- Edit/branch/regenerate preserve everything (see G4).
- **Drafts do not:** `ChatDraftRow` persists text + attachments + `templateBinding` +
  `foldedLinks` only (`lib/db/chat-drafts.ts:84-129`). `contextSelections` — the chips
  carrying snapshot + fingerprint — live only in in-memory Zustand
  (`stores/chat/chat-store.ts:597`), so a reload drops every staged reference, and the
  cross-device `draft.replace` host-state intent carries even less.

### Observability → Gap

- No reference-specific events (resolve / inject / stale-shown / denied). The only signal
  is generic `chat.message.sent` in `lib/telemetry/events/catalog.ts`. Same hole the doc
  calls out for markone.

## Conclusion

Of the doc's eight gaps: **G1, G2, G3 and the lifecycle core are covered**; **G4–G8 are
present in varying degrees**, plus one shared observability hole. Priorities:

| #   | Gap                                                                                        | Location                                                                                        |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | Direct-chat steer (live + queued) drops `metadata.mentions`/`promptPreamble` → no backlink | `use-claude-chat-controller.ts:852-957`, `lib/claude/steer.ts`, `chat-store.ts:34`              |
| 2   | Shared-session `message.created` has no metadata field → backlinks blind on all members    | `shared-run-coordinator.ts:407-416`, `shared-chat-sync.ts`, `shared-chat-conversion.ts:361-373` |
| 3   | `room_send` RPC + host-state intents have no citations/preamble fields                     | `room-send-client.ts:22-38`, `room-write-handlers.ts:159-170`, `host-state.ts:115-133`          |
| 4   | Drafts do not persist `contextSelections`                                                  | `chat-drafts.ts:84-129`, `chat-store.ts:597`                                                    |
| 5   | No audience check/warning when a transcript with embedded references is shared/published   | `shared-run-coordinator.ts`, `shared-chat-conversion.ts`, `shared-session-panel.tsx`            |
| 6   | No reference-path telemetry                                                                | `lib/chat/mentions/*`, `lib/telemetry/events/catalog.ts`                                        |

Secondary notes: room `referenceMetadata` ignores typed `@` mentions (`runner.ts:1731`);
`@chat:` snapshot bound `MAX_TRANSCRIPT_MESSAGES = 40` and frozen-copy-on-revocation are
deliberate product semantics that differ from the doc's stated expectations and deserve
an explicit decision, not silent divergence.
