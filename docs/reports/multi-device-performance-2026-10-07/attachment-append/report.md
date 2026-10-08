# Attachment append performance — 2026-10-07

Kept a narrow change to `lib/db/session-attachment-uploads.ts`: each append now performs the owned-row read, existing checks, byte assembly and full-row `put` inside one IndexedDB read/write transaction. Previously the owned-row `get` was followed by Dexie `update`, whose `modify` implementation fetched the complete accumulated payload again. The transaction removes that second read while preventing the replacement write from overwriting a concurrent append or recreating an aborted row.

No upload schema, chunk size, wire command, byte/hash/type check, client concurrency, retention policy or commit verification changed. The optional database argument on the existing `ownedRow` helper keeps its lookup on the database captured for this transaction.

## Native browser result

The same minified bundle contains the frozen baseline and candidate. Each scenario ran one warmup per variant and ten measured samples per variant in alternating order. The baseline-only run saved before production editing establishes the initial baseline; the alternating run is the decisive comparison.

| Scenario                                  | Baseline median / MAD | Candidate median / MAD | Decision                                                                  |
| ----------------------------------------- | --------------------: | ---------------------: | ------------------------------------------------------------------------- |
| Full 10 MiB upload, 320 chunks            |   2,202.70 / 49.15 ms |    1,729.90 / 89.55 ms | **21.46% faster**, 472.80 ms saved; exceeds 10% and 2×MAD = 179.10 ms     |
| Full 1 MiB upload, 32 chunks              |       52.25 / 3.70 ms |        41.25 / 1.30 ms | **21.05% faster**, 11.00 ms saved; exceeds 2×MAD = 7.40 ms                |
| Resume 10 MiB upload from 50%, 160 chunks |  1,449.70 / 242.90 ms |   1,132.65 / 156.30 ms | Guard passes, **no speedup claim**: the delta is within 2×MAD = 485.80 ms |
| Already committed 10 MiB attachment       |        8.60 / 0.25 ms |         8.60 / 0.15 ms | Unchanged; zero chunks retransmitted                                      |

The primary registered outcome and all guardrails pass. The earlier baseline-only 10 MiB median was 1,960.95 ms; its difference from the later alternating baseline reinforces why temporally separated groups were not used for the decision. Resume noise is reported rather than concealed by its lower median. No p95 estimate is made from ten samples.

For the 10 MiB scenario, measured DBCore `get` + `getMany` row selections fall from **642 to 322**, removing one `getMany` per chunk. These counters do not include rows from `query`/cursor operations and are not a count of physical disk reads or decryption operations. The table's current catalog class is `metadata-only`, so the avoided work is not encrypted-content decryption.

Every measured run validated the completed attachment byte-for-byte after timing. Baseline and candidate preserve 320 chunk calls, 14,009,809 JSON request-body bytes and 321 put operations for the full 10 MiB scenario. The resume and dedup cases also preserve chunk counts, request bytes and writes. The fixture supplies the cached SHA-256 that the normal remote composer already passes, and commit still independently verifies the received bytes with native WebCrypto.

## Scope and limitations

- Apple M4 Pro, 48 GiB, macOS, AC power at 100%; Headless Chromium 151.0.0.0. Same machine, browser, bundle and fixtures for both variants.
- This runs actual `uploadSessionAttachment` and actual exported host begin/append/commit/resolve functions on **native IndexedDB**, with real JSON request/response serialization and base64 encode/decode. A local RPC adapter injects the fixture device identity and connects those functions. The native browser guard also checks persisted resume after closing/reopening the database.
- A minimal Dexie database uses the exact production `sessionAttachmentUploads` indexes. Full CogniaDB initialization, unrelated tables, app routing/middleware, authentication, host RPC dispatcher, at-rest encryption, real sockets, RTT, UI and mobile shells are excluded. This attachment table is not account-sync-captured and is currently metadata-only. The result therefore proves the exercised local client/host upload boundary, **not** deployed end-to-end or physical-device transfer latency.
- Chunk persistence still rewrites the accumulated byte array. This change removes the duplicate read; it does not eliminate the underlying quadratic byte-copy/write growth.
- Only the append's read/check/write is made atomic. Existing sweep, begin, commit, consume and other lifecycle operations still have their existing boundaries. The tests do not prove all possible races, multi-window or cross-device interleavings are fixed.

## Correctness and checks

- New adjacent-concurrent-append regression failed against the baseline with `attachment_offset_mismatch` and passes with the candidate.
- New overlapping append/abort regression ensures the upload remains absent and a later append is refused.
- Native Chromium guards passed for adjacent concurrent appends, byte-for-byte content, persisted resume after database reopen, and overlapping abort (`native-guards.json`). These use one browser context; cross-window behavior was not exercised.
- Existing host/client tests cover sequential transfer, offset gaps, retries, resume, deduplication, ownership, session scope, hash/type validation, TTL and commit behavior.
- `rtk pnpm exec jest lib/db/session-attachment-uploads.test.ts lib/companion/attachment-upload-client.test.ts --runInBand`: **37 passed**, two suites.
- Scoped ESLint, Prettier check and `git diff --check`: passed.
- Independent parent-assigned read-only review found no newly introduced issue; the lifecycle boundaries noted above remain outside scope.

## Evidence and reproduction

- `contract.md`: preregistered workload and decision rules.
- `baseline-host.ts.txt`: original production host module, frozen before mutation.
- `baseline-before-edit.json`: 40 baseline-only samples collected before production editing.
- `comparison.json`: 80 decisive alternating samples with counts and user agent.
- `metrics.json`, `summarize.py`: statistics and parity checks derived from the raw samples.
- `benchmark.ts.txt`, `build.mjs`: reproducible bundle using installed repository dependencies.

From repository root, build and serve the disposable harness:

```sh
rtk proxy node docs/reports/multi-device-performance-2026-10-07/attachment-append/build.mjs
rtk proxy python3 -m http.server 18749 --bind 127.0.0.1 --directory /tmp/cognia-attachment-browser-2026-10-07
```

In another terminal, use an isolated browser session (keep other benchmarks and heavy checks idle):

```sh
rtk proxy agent-browser --session attachment-append-20261007 open http://127.0.0.1:18749
rtk proxy agent-browser --session attachment-append-20261007 eval 'window.runAttachmentGuards()'
rtk proxy agent-browser --session attachment-append-20261007 eval 'window.runAttachmentBenchmark("compare")'
rtk proxy agent-browser --session attachment-append-20261007 eval '({ progress: window.attachmentProgress, error: window.attachmentError, done: Boolean(window.attachmentResult) })'
```

When complete, export `window.attachmentResult` to `comparison.json` and run `rtk proxy python3 docs/reports/multi-device-performance-2026-10-07/attachment-append/summarize.py`. The harness deletes only its fresh random-name test databases. The browser session and loopback server used for this run were closed; `/tmp` bundles remain reproducible artifacts. No tests add a flaky wall-clock CI threshold.
