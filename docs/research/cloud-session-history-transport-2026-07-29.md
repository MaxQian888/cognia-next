# Cloud session/history transport research — 2026-07-29

## Scope

This report traces the plain-web cloud-companion path defined by ADR-0059:

`WebCompanionBootProvider` → `CompanionTransport` → `cognia-server` RPC →
headless/WebView bridge → Dexie.

The investigation focused on cold boot, the conversation list, and opening a
long-running conversation. AI SDK token streaming is a separate event path and
was not the bottleneck here.

## Findings

### 1. Cold boot drained the complete message database

`runSyncDown()` called the messages handler during initial hydration. The
desktop source returned 500 rows and `has_more: true`; the generic handler then
kept calling `sync_pull` until every historical row had crossed the WAN.

Consequences:

- cold-start bytes and round trips grew with account age;
- the browser could not render the sidebar until all 16 table handlers had run
  sequentially;
- every browser profile repeated the transfer after losing/resetting its local
  cursor;
- the comment in `handlers/messages.ts` promised a bounded recent snapshot,
  while the implementation deliberately drained full history.

### 2. Pagination happened after full materialization

`readSessionPage()` loaded every `ChatSession`, filtered and sorted in memory,
then sliced the requested page. `ChatSession` is not a list DTO: it can carry
large `systemPrompt`, `scratchpad`, `branchSeed`, and custom configuration
fields.

`readMessagesPage()` similarly called `messageRepository.getBySessionId()`,
which materialized and converted the complete transcript before applying
`limit` and `offset`.

Both endpoints therefore had page-shaped responses but unbounded source work.

### 3. Companion HTTP responses were not compressed

The axum router had request-size limits but no response `CompressionLayer`.
Large JSON deltas crossed the wire uncompressed even when the browser sent
`Accept-Encoding: br, gzip`.

### 4. WS replay is already bounded

The event bus keeps a 200-frame replay ring and emits `resync_required` when a
cursor falls behind. It can trigger a resync, but it does not carry historical
session transcripts and is not the primary payload amplifier.

### 5. Sequential table pulls remain an RTT cost

The orchestrator intentionally runs handlers sequentially. With 16 tables, an
empty cold sync costs roughly 16 request/response latencies. This is visible on
a WAN, but batching before bounding the history payload would only place the
same unbounded data inside a larger envelope.

## Implemented protocol: bootstrap fold + lazy unfold

The optimized flow keeps the existing RPC names and numeric cursors.

### Phase A — bounded bootstrap fold

For `sync_pull({ table: "messages", since: 0 })`:

- query the `[createdAt+id]` index from newest to oldest;
- return at most 500 rows, reordered oldest-to-newest for deterministic apply;
- return `has_more: false`;
- advance `next_since` to the newest returned timestamp.

This folds old transcripts behind their session entries. The sidebar still has
`ChatSession.lastMessagePreview` and `lastMessageAt`, so it does not need every
message to render.

### Phase B — lossless incremental sync

For `since > 0`, behavior remains lossless:

- query forward from the cursor;
- return 500 rows per page;
- keep `has_more: true` while a page is full;
- let the generic handler drain all new/offline changes.

Cold history is bounded; new history is not dropped.

### Phase C — lazy per-session unfold

When a cloud-browser user opens a session:

- call `message_get_by_session` in pages of 200 (server cap 500);
- query Dexie through `[sessionId+createdAt]` with `offset` and `limit + 1`;
- infer continuation from the extra row instead of recounting the session on
  every page;
- validate that every row belongs to the requested session;
- `bulkPut` raw `StoredMessage` rows into local Dexie;
- coalesce concurrent requests and cache completion for the browser lifetime;
- classify the page RPC as read-only so it does not mint idempotency keys;
- run this path only in plain-web mode, never Tauri or Capacitor;
- then publish the complete local transcript to the chat store.

If an older server cannot serve the lazy protocol but a recent local tail
exists, the UI keeps that tail and logs the compatibility fallback.

### Session-list DTO

`session_list` now uses the `updatedAt` index, caps caller requests at 200
rows, reads only one extra exposed row to determine `has_more`, and returns a
projection:

- identity/title/kind;
- workspace/character/team ids;
- last-message preview/time;
- created/updated timestamps.

Execution-only fields never cross this list boundary. `has_more` and
`next_offset` replace the need for an exact `total`; exact totals required a
full filtered scan and no current consumer used them. Direct/degraded stores
may still include `total`, so the client type keeps it optional.

## Synthetic bound check

A deterministic synthetic check used 50 session rows, each with three 64 KiB
text fields, and 10,000 roughly 1 KiB messages:

| Surface                             |       Before |     After | Reduction |
| ----------------------------------- | -----------: | --------: | --------: |
| 50-row session list JSON            |  9,840,170 B |   5,670 B |    99.94% |
| Cold message bootstrap JSON         | 11,421,794 B | 571,211 B |    95.00% |
| Folded page with Brotli (candidate) |    571,211 B |   1,364 B |    99.76% |
| Folded page with gzip (candidate)   |    571,211 B |   6,155 B |    98.92% |

These figures demonstrate bounds and compression behavior, not production
traffic ratios. Real compression depends on message entropy. The structural
guarantees are the important result: bootstrap rows are capped at 500,
session-list rows are projections, and per-session reads are capped per page.

Application-layer compression was prototyped with `tower-http 0.6.11`'s
`CompressionLayer`, but it requires the additional Rust `async-compression`
dependency and could not be verified in the local offline dependency cache.
It is deliberately not part of this change. Cloud deployments can enable
Brotli/gzip at Caddy today; adding it directly to `cognia-server` should be a
separate, dependency-verified slice with a real-router content-encoding test.

## Batch/folded envelope considered

A future `sync_pull_batch` could reduce the remaining 16-RTT cold-start cost.
It should not be a single all-or-nothing blob. A safe v2 envelope needs:

- independent `{ table, since }` inputs;
- independent success/error outcomes per table;
- per-table `next_since` and `has_more`;
- a server-side byte budget that can stop before one large table starves the
  others;
- cancellation and retry semantics that do not regress monotonic cursors;
- no idempotency cache for read-only deltas.

It was not added in this change because payload amplification was the dominant
problem and the existing protocol can solve it compatibly. The next measured
step should compare bounded parallel pulls (for example concurrency 3–4)
against a batch envelope under realistic WAN latency before expanding the RPC
surface.

## Remaining limitations

- The message cursor is a millisecond timestamp. More than 500 rows sharing one
  timestamp can still make an incremental page repeat. A future opaque cursor
  should encode `(createdAt, id)` end-to-end.
- Lazy history completion is cached in memory. A browser reload performs a
  cheap first page again; persisted completeness metadata could remove that
  probe if measurements justify another schema field.
- Session-table sync still carries full session configuration because the
  browser chat runtime consumes those settings. The separate `session_list`
  projection must remain lightweight.
- Table pulls are still sequential; measure RTT after this payload fix before
  selecting bounded concurrency or `sync_pull_batch`.
