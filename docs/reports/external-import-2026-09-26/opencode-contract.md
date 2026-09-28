# OpenCode run-scoped indexes experiment (2026-09-26)

User path: read a real OpenCode share-export JSON file from disk into the picker input, list all root sessions, then parse selected session graphs. The same per-run input serves every selected ref, exactly as importer behavior. Primary duration includes file read, JSON parse/normalization, listing/content revisions, every selected parseGraph.

Hypothesis: collectSessions already caches normalized sessions within one input but parseSession rebuilds complete child adjacency and scans IDs per ref; parseGraph also rebuilds a complete IDMap per ref. Build indexes once with the existing per-input load promise. Preserve first-wins conversation lookup, last-wins structured-state lookup, duplicate child entries, cycle skipping and failed-read eviction. New input always rereads; no process-global mutable graph cache or auth/LLM changes.

Predeclared fixtures: batch10,000sessions grouped as2,500roots with3children each,2messages/session, select128roots; single guard same corpus/select1; small4sessions/select1; large-tool1session/600messages with32KiB tool output per alternate assistant. Flat keyed share-export JSON, deterministic IDs/timestamps. Actual filesystem fixture and real parseGraph, no mocked parser/graph conversion. Both arms compile real adapter with only source variant changed and same current helper modules.

Optimized esbuild Node bundle on M4 Pro48GiB.2warmups then12AB/BA pairs per fixture, fresh run input and fresh file read every iteration, warm OS cache/no cache clearing. Median/MAD: require >=10% and delta >2×largerMAD on batch. Guards: no >10% latency regression beyond noise; retained heap increase <=10MiB. Complete listing+graphs byte/SHA256 equality every iteration. Run benchmark serially with parent/other worker.

Focused Jest verifies duplicate first/last semantics, child order/cycles/orphans, freshness across inputs, failed retry and existing mappings/losses/usage/background jobs. Direct local Jest/ESLint/Prettier only; no fullbuild or global typecheck. Changes owned only opencode.ts/test.ts and opencode-* evidence; no Rust/db reader changes. Unsupported performance-only edits will be removed.
