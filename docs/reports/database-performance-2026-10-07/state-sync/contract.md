# Session-state sync experiment — 2026-10-07

User path: apply a Host session unread-state delta while preserving pending local read/unread choices. Primary metric: actual `syncSessionState` pull/apply completion latency, native Chromium IndexedDB, minified production browser bundle. Database schema/provider isolated with the exact two current table schemas; application encryption middleware, network, UI, native shells excluded.

Hypothesis: replacing the per-row queue reduction with a read-through map in the existing queue pass removes O(delta rows × pending jobs) work without changing stored rows or outcomes.

Pre-registered workload: small 20 incoming rows / 20 valid pending jobs (+ 4 unrelated/foreign); ordinary slice 200 incoming / 200 valid (+ 40); offline backlog stress 1,000 incoming / 5,000 valid (+ 1,000). Queue is fixed per workload. Fresh seeded state table before each run, warm browser/queue cache, two warmups then 15 baseline and 15 result samples, alternating execution order. Baseline and result run on the same synthetic DB. Jobs include read/unread, sending/pending, timestamp/client-sequence ties, unrelated/foreign scopes. Result comparison is exact stored JSON plus outcome, cursor, tombstone absence, and unchanged queue count.

Decision: stress primary median improves >=10% and absolute delta >2×larger MAD; small and ordinary medians may not regress by both >10% and >2×larger MAD. Report raw durations/median/MAD. No p95 claim from 15 samples. No timing assertion in CI.

Allowed mutations: this report directory, isolated /tmp HTML/bundle and HTTP server, isolated agent-browser session and synthetic IndexedDB, lib/sync/handlers/session-state.ts and co-located test. No user database, credentials, migration or schema edits.

Baseline capture: baseline-session-state.ts.txt before implementation edit. Build `rtk node docs/reports/database-performance-2026-10-07/state-sync/build.mjs`; serve /tmp/cognia-state-sync-benchmark-2026-10-07 on port 8768; run via isolated agent-browser session. Correctness: focused session-state + base + companion orchestrator suites and ESLint. Native WebView/Capacitor/remote Host unverified.

## Pre-measurement amendment

Plaintext diagnostic was not accepted as representative and partially overlapped another agent's CPU timing. Final experiment adds the actual `createEncryptedContentMiddleware`, actual account content cipher and WebCrypto with the existing governance policy (`sessionState`: encrypted-content; `mobileOutboundQueue`: metadata-only). Same fixtures/sample counts/noise/threshold. Saved baseline source is bundled side-by-side with current implementation. The final claim excludes transport/network and rendering, but includes actual encryption, native IDB transactions and pacing. Baseline pre-edit plaintext and overlapping plaintext results are diagnostic only.
