# Attachment append experiment — 2026-10-07

Registered before changing production source or collecting timing.

- Primary user path: upload one 10 MiB attachment through the real `uploadSessionAttachment` client and real host begin/append/commit functions, using native Chromium IndexedDB and WebCrypto. The RPC adapter serializes JSON and decodes base64 locally; actual transport/network/auth routing is excluded.
- Hypothesis: each append reads the accumulated payload with `get`, then Dexie `update` reads it again via `modify/getMany`. One read/write transaction containing `get`, validation and `put` removes the second read without weakening durability or changing wire/storage schema.
- Primary: complete local upload wall time (ms) for 10 MiB. Guards: complete 1 MiB upload; 50%-resumed 10 MiB upload; already-committed 10 MiB deduplication. Guard regressions must be <=5% or within 2*larger MAD.
- Fixture: deterministic PNG-header byte pattern, 32 KiB host-advertised chunks; precomputed hash, as in the production remote composer; private device/session binding; fresh isolated database per execution. Full byte payload equality, hash/ref/size, confirmed progress, chunk count and JSON request bytes checked.
- Storage: actual production functions against a minimal Dexie database containing the exact production attachment-table indexes. This table is metadata-only and not account-replicated; unrelated CogniaDB middleware and tables are excluded and that limitation must remain explicit.
- Environment: same Apple M4 Pro / 48 GiB / macOS machine and AC normal power mode as first round, native Chromium version recorded by harness. Same minified esbuild browser bundle contains frozen baseline and candidate.
- Baseline source frozen as `baseline-host.ts.txt`. Before production mutation, collect a baseline-only run (1 warmup +10 samples/workload). Final comparison: 1 warmup per variant/workload, then 10 samples per variant/workload in alternating order; no cache deletion outside disposable benchmark DBs.
- Acceptance: primary median reduction >=10% and greater than 2*larger MAD; correctness and guards must pass. Report median/MAD/raw samples and deterministic DBCore get/getMany counts; no p95, battery, network or physical-phone claim.
- Keep no performance-only source change if the primary result fails. Timing is manual, not a CI assertion.
- Side effects permitted: owning attachment source/test/report files, minified harness in `/tmp/cognia-attachment-browser-2026-10-07`, loopback server port18749 and isolated browser session `attachment-append-20261007`, disposable IndexedDB databases. No schema migration, dependency change, deployment or user file upload.
- Verification: focused Jest, ESLint/format checks; native harness integrity checks and concurrency/abort/order/resume regressions. Coordinate timed runs with parent to avoid contention.
