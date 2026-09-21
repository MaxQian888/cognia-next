# Memory and context strategy review — 2026-09-21

Cognia should retain its governed local memory, project-claim corpus, and durable
job queue. The reference document's useful transferable ideas are bounded recall,
independent failure domains, evidence identity, and distinguishing unavailable
data from deleted data. Its cloud authority and detached-process lifecycle are
properties of disposable sandboxes, not requirements for Cognia's persistent hosts.

## Reference decisions and their application

| Reference strategy                        | Assessment for Cognia                                                                                             | Applied behavior                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cloud memory is authoritative             | Appropriate for that sandbox topology; conflicts with Cognia's local ownership and governance if copied wholesale | Preserve existing stores, namespace rules, and native runtime memory ownership                                                     |
| Parallel recall with independent failures | Useful, but a 15-second network wait is too long for interactive prompt preparation                               | Preserve healthy personal/procedural results independently; bound the remote vector leg to 700 ms by default with lexical fallback |
| Content-change identity                   | A count and maximum timestamp cannot detect all corpus changes                                                    | Compare exact eligible document ids/text before reusing a cached lexical index                                                     |
| Changed-only injection                    | Useful only when the host proves earlier context remains present after compaction/recovery                        | Keep per-turn bounded context and delivery receipts; do not omit context merely because an earlier turn saw it                     |
| Startup/end detached flush                | Needed by disposable sandboxes, but insufficient for durable completion/retry guarantees                          | Keep the leased job queue, stop new claims on worker teardown, and let an already claimed operation finish                         |
| Always exit successfully / best effort    | Keeps foreground work available but can conceal permanent data loss                                               | Foreground recall degrades; background provider failures reach the existing retry state machine                                    |
| Suppress deletion on incomplete reads     | Essential beyond synchronization                                                                                  | Evidence-storage failures propagate for retry; only a successful absent-source read can revoke a citation                          |
| All consumers default on                  | A product/privacy choice, not a universal reliability optimization                                                | Preserve current user/session/agent policy and cloud-embedding opt-in                                                              |
| Local conflict winner                     | Convenient for files; not evidence that a mined claim is true                                                     | Preserve consolidation conflict/quarantine and explicit review                                                                     |
| Runtime-specific homes                    | Necessary for isolation                                                                                           | Existing managed execution already establishes task-scoped `HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`; preserve it              |

## Implemented contracts

### Recall and prompt preparation

- Personal/procedural source failures are isolated. Procedural context uses the
  same expiry, conflict, quarantine, and review eligibility rules as retrieval.
- Shared BM25 document-length statistics are maintained incrementally across
  insertion, replacement, removal, clearing, and snapshot restore. Cold index
  construction no longer rescans every previously inserted document per row.
- Prompt packing measures the complete rendered section using Cognia's existing
  token estimator, including headings, separators, and optional project-history
  hints. This is an estimated budget, not a model-tokenizer guarantee.
- Procedural delivery receipts contain the exact selected ids/versions; multiline
  text counts as one memory rather than several lines.
- Vector work uses a 700 ms default deadline, optional cancellation, and explicit
  `retrieval_timeout` degradation. Late embeddings cannot start a vector search.
  At most eight vector operations remain outstanding per process; a provider
  that ignores cancellation cannot accumulate unlimited requests. An abandoned
  operation retains its slot until it actually settles.
- Authorized vector documents are read in batches of at most 256. Every eligible
  id is still considered; only the best K scores survive between batches.
  Unexpected document ids and non-finite vectors are excluded.
- Cancellation reaches the existing embedding adapter's `abortSignal`; vector
  stores without transport cancellation stop before the next batch. Metadata
  access-time writes no longer delay the retrieval result.
- The vector write sink independently rejects PII-bearing content before sending
  it to a provider, supplementing existing gates at its callers.

### Mining and evidence

- The production mining factory opts into provider/storage error propagation so
  the existing durable worker can retry. Invalid structured output remains a
  deterministic no-output result.
- The extractor accepts at most five valid claims, isolates malformed entries,
  deduplicates citations, and checks message/tool anchors against the supplied
  source window. Real tool-part metadata prevents prose from impersonating tool
  results. Outcome claims require a tool-result citation.
- A code-path mention remains a citation, not verified file existence or proof
  that the claim is true. Existing code-location evidence stays unverifiable on
  hosts that cannot validate it; no fabricated validation is introduced.
- Path/branch applicability is preserved through consolidation. Invalid paths,
  missing applicability rationale, or an unknown historical branch cannot
  silently widen a claim into workspace-wide context. The current checkout is
  not substituted for the historical source branch.
- Similarity lookup supplies the reader's actual path for scoped candidates.
  Updating a project claim preserves its new citation set and extraction
  metadata through both consolidation and worker evidence attachment.
- Colon-bearing message ids remain intact in evidence attachment and rechecks.
  Malformed tool suffixes cannot certify a message as tool evidence.
- An unchanged source establishes freshness, not truth. Evidence rechecks cannot
  lift an unreviewed claim's quarantine; explicit verification is required.
- A queued job cannot write using its old project or character after its source session changes.
  Worker startup/interval errors emit a content-free diagnostic and recover on
  a subsequent tick.

## Initial memory-phase verification and boundaries

Regression tests exercise real memory entry points, send-options integration,
headless worker registration, failure recovery, evidence validation, source
isolation, bounded vector batches, cancellation, and exact receipt/budget data.
Coverage was explicitly skipped at the user's request.

The combined `packages/memory/src`, `lib/memory`, `packages/rag/src`, send-options
memory integration, and headless-memory registration run completed with exit 0:
106 suites / 1,530 tests passed. Scoped ESLint, Prettier, and `git diff --check`
also passed. Two existing collection-manager tests now destroy their temporary
instances, eliminating autosave timer leaks exposed by the broader run.

Repository-wide TypeScript was rerun directly with the configured 16 GB heap
after the command wrapper's 4 GB run exhausted memory. Its final result is one
diagnostic outside this change: `lib/router-fusion/runtime/delegate-host-ports.test.ts:235`
(`TS2769`, the child-process environment object lacks required `NODE_ENV`). No
diagnostics remain in this task's changed files. The repository-wide type gate
is therefore not reported as passing.

### Synthetic recall timing

Measured with 115-character English memory rows, 1% query matches, five cold
runs and twenty warm queries per size. These measurements exclude database and
network I/O and are sensitive to concurrent machine activity.

| Eligible rows | Cold p95 before | Cold p95 after | Warm p95 before | Warm p95 after |
| ------------- | --------------: | -------------: | --------------: | -------------: |
| 10,000        |        163.9 ms |        89.8 ms |         6.73 ms |        8.14 ms |
| 100,000       |     10,936.4 ms |       950.4 ms |         78.1 ms |        63.7 ms |

The 100,000-row cold p95 improves about 11.5 times. Its 950.4 ms still exceeds
the ADR's 700 ms first-batch target; this is not full production SLO acceptance.
The small 10,000-row warm-query difference is not evidence of an improvement.

The changes do not establish live hosted-provider latency, native-device
acceptance, cloud synchronization acceptance, or model recall quality on a user's
private corpus. The vector deadline does not bound a stalled local database read;
the existing storage layer still owns that failure domain. Synthetic timing
results are reported separately from runtime/network measurements.

## Source evidence

- Reference: `/Users/bytedance/Project/markone/packages/sdma-server/docs/background/memory-and-context-management-public.md`
- Architecture and authority: `docs/content/docs/en/adr/0115-unified-memory-rag-infrastructure.md`, `lib/memory/CONTEXT.md`
- Recall: `packages/memory/src/retrieve/retriever.ts`, `packages/memory/src/runtime/apply-memory-context.ts`, `packages/memory/src/runtime/project-continuity-context.ts`, `packages/memory/src/procedural.ts`
- Shared index: `packages/rag/src/hybrid-search.ts`
- Environment adapters: `lib/memory/runtime/build-deps.ts`, `crates/cognia-external-agent/src/process.rs`, `lib/memory/external/providers/codex.ts`
- Mining: `lib/memory/write/run-project-mining.ts`, `packages/memory/src/extract/project-extractor.ts`
- Lifecycle: `lib/memory/lifecycle/job-worker.ts`, `lib/memory/lifecycle/revalidate-claim.ts`

## Multimodal source lifecycle extension

Attachment content remains external evidence. Uploading a source is not consent
to learn personal facts from it, and a generated transcription or description is
not an authoritative instruction. The implementation extends the existing message
media store, document processors, provider operation plane, and governed mining
pipeline instead of introducing another vector database or opaque summary store.

### Source, derived content, and recall

- Session-owned original blobs are stored separately from transcript previews.
  SHA-256 identity, owner checks, an explicit 500 MiB source ceiling, and a 1 GiB
  source quota prevent cross-session access and unbounded retention. Resizing a
  local image for delivery preserves its original; large sources hash in 1 MiB
  chunks. The two-slot processing queue retains a slot until cancelled work
  actually settles, even when a provider ignores cancellation.
- Derived segments carry document pages, sheet ranges, slides, image regions,
  text offsets, or audio/video time ranges. Processor identity, coverage and
  partial/failed/cancelled status survive the transcript, draft, source store,
  and backup. A partial representation is never labeled a complete source.
- PDF processing checks text coverage per page and invokes the existing OCR
  fallback for unreadable pages. Rich document processors retain source
  locations. All extracted segments remain accessible; initial prompt injection
  chooses relevant bounded excerpts rather than dropping the document tail.
- The actual agent runtimes expose `attachment_list`, `attachment_search`, and
  `attachment_read`. They obtain scope from the active session, enforce revision
  consistency across pages, preserve source offsets, and screen whole segments
  for PII before slicing a response. Excerpt headings are screened too.
- External attachments never enter automatic personal-memory extraction as user
  prose. Project evidence extraction respects external-learning policy, records
  exact source hashes and locations, and quarantines proposed facts for review.
  An unchanged source establishes freshness, not truth. Deleting or replacing
  its extraction invalidates linked claims atomically; a tombstone prevents old
  transcript replay from silently restoring a removed source.

### User actions and environment behavior

- Attachment preview offers local audio playback and explicit provider/model
  selection for transcription and visual description. Cloud interpretation does
  not start merely because a file was staged. Progress, cancellation, retry,
  errors and incomplete coverage are visible. Generated text passes the existing
  redaction boundary before entering model context.
- Video sampling and interpretation are distinct. A changed storyboard does not
  discard an already located transcription of the same source. Large video
  transcription uses bounded 30-second chunks through local ffmpeg when available;
  an environment without that capability returns an explicit failure.
- Source persistence completes before local, external, shared, and companion
  dispatch. A persistence error stops the send and retains the draft. Rejected
  attachments cannot silently disappear while the remaining text is submitted.
  Verified draft caches are rebound to new staging IDs only after content hash
  validation. Message cards provide original download and source removal; video
  cards also expose the transcription/description that the model received.
- Shared or imported derived-only records explicitly report unavailable originals
  and cannot borrow another session's matching blob. Remote uploads retain their
  published transfer ceiling; oversized originals are rejected before resizing.
  Remote/CLI inputs do not advertise audio processing where the corresponding
  interactive operation is unavailable. Native binary inputs without extracted
  text remain explicitly partial rather than inventing an index.
- JSON and streaming backups include source bytes, derived metadata, canonical
  preview media and thumbnails with integrity validation and owner remapping.
  Binary payloads are not labeled PII-clean by the text scanner. CLI persistence
  uses bounded binary sidecars and small manifest references, avoiding V8's JSON
  string limit for accepted large files. Restart and backup recovery retain exact
  bytes; orphan collection keeps files referenced by current and backup manifests.

### Large-file runtime completion

- Manual local export, interval backups, and cron backups use the v4 encrypted
  stream in the running application. Desktop and headless writers stage a sibling
  file and rename it only after every chunk has been written. A failed generation
  or write preserves the previous destination. Browser export retains Blob parts
  without joining the whole archive into a JavaScript string.
- Restore authenticates the final record before entering the existing atomic
  apply pipeline. Binary records become Blob pieces outside the preview JSON;
  large text rows use authenticated fragments without raising the 16 MiB physical
  record limit. The logical row limit is 128 Mi UTF-16 code units. Wrong-passphrase
  retries reopen the source rather than retaining another full archive string.
  Header detection handles short reads, switching files invalidates pending work,
  and successful application releases the retained binary buffers.
- Existing string-only remote/share transports remain bounded: more than 32 MiB
  of source/preview bytes or 64 MiB of serialized JSON produces an explicit error
  directing the user to local streaming export. No source is silently omitted.
  A remote preparation failure is recorded separately from a successful local
  backup. Legacy JSON imports have a 128 MiB input ceiling.
- CLI restart retains file-backed native Blobs wrapped in a structured-cloneable
  Blob. It verifies sidecar hashes incrementally and preserves an existing valid
  sidecar's inode during repeat snapshots, so restored Blob handles stay valid.

A fresh-process test used an actual 500 MiB original and Cognia's Dexie database:
startup/restore took 382 ms, a complete source rehash took 2.618 seconds, and a
metadata update plus repeat snapshot took 1.471 seconds. Peak RSS across these
operations was 284.84 MiB, down about 77% from the earlier materializing restore's
1.21 GiB. Source hashes matched and the final snapshot referenced one original
sidecar without duplicating its bytes. This is a local CLI persistence benchmark,
not a media decoding, hosted-model, or native WebView measurement. Temporary
benchmark data was removed afterward.

An independent real-Dexie round trip exercised source export, v4 decoding, and
the restore source validator without collecting the complete backup string:

| Source size and encoding               | Export plus decode | Process RSS start / peak | Result                           |
| -------------------------------------- | -----------------: | -----------------------: | -------------------------------- |
| 500 MiB, plaintext with checksum chain |           26.425 s |        331.0 / 935.6 MiB | Exact bytes and SHA-256 restored |
| 64 MiB, AES-GCM encrypted chunks       |            4.410 s |        258.5 / 384.7 MiB | Exact bytes and SHA-256 restored |

The largest encoded records were 65,806 and 87,810 bytes respectively. The restore
reader retains the recovered source Blob, accounting for most of its memory
growth; these measurements do not imply constant total restore memory. The
500 MiB measurement is plaintext, not an encrypted-backup timing. Both temporary
sources and isolated databases were removed after verification.

### Validation evidence

Coverage measurement remains skipped at the user's request. Focused regression
runs cover source ownership and deletion, backups and CLI restart, provider
failure/cancellation, document locators, bounded excerpts and tool pagination,
mining quarantine, send preflight, draft restoration, and renderer controls.
The main attachment UI/renderer/draft run passed 10 suites and 332 tests; the
memory regression run passed 75 suites and 997 tests. These are separate runs,
not an aggregate unique-test count.

The browser flow was checked locally for attachment intake, audio playback,
explicit model selection, and refusing an unprocessed audio send while retaining
both staged files. No paid provider call or native-device transcription
acceptance was performed. The final source/draft checks passed another 2 suites /
51 tests, and storage/backup/share checks passed 12 suites / 300 tests. The
attachment-specific hook checks passed 16 tests; the broader hook runs exposed
existing managed-workspace fixtures without IndexedDB and a Team Chat provider
fallback assertion (`use-team-chat.test.ts`, expected two sends but received one).
Those broader runs are not reported as passing.

The large-file CLI persistence tests passed 2 suites / 92 tests. Scheduled backup
filesystem/provider/executor checks passed 5 suites / 40 tests; the subsequent
focused failure-isolation run passed 2 suites / 33 tests, including the added
cases that preserve a local backup when remote preparation fails. These runs
overlap and are not summed.

The final streaming export/import run passed 10 suites / 163 tests. The subsequent
private-file-permission check passed 36 tests. The reused Rust core passed all
34 tests, including temporary-path authorization, traversal, collision and symlink
checks. The native command was compiled to metadata against the cached Tauri
dependencies, its local command permission was regenerated from the handler list,
and its frontend invocation was checked. Full Tauri linking and packaged-device
acceptance were not performed.

Repository-wide TypeScript completed with a 16 GiB heap. After fixing this
extension's diagnostics, the shared tree still reports unrelated project
environment, router-fusion, run-detail and CLI fixture errors (13 diagnostics in
the final run, none in this task's changed files). The global type
gate is not passing. Scoped ESLint, locale generation freshness/key checks, and
diff whitespace checks passed. Coverage, commits, pushes and deployment were not
performed.
