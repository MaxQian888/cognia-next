# Codex history experiment (2026-09-26)

Baseline `10c36223d479a08efe918e7035f1c14a42ed3534`; codex.ts initially clean.
User path: scan local rollout history, select conversations, read/parse complete
canonical conversation graphs. Primary metric includes actual file reads,
summary scanning, parsing and graph conversion; excludes Dexie/UI/IPC transport.

Hypothesis: parsing is already cached per import input, but every selected ref
rebuilds the full ID and parent/children indexes. Index once per existing cache
lifetime to remove O(selected refs × corpus) bookkeeping without stale new scans.

Fixed generated fixtures: 2,500 independent rollout files with eight messages
each (128-character text); guard one long 20,000-message rollout; guard two small
eight-message files. Real temporary files, warm OS cache. Fresh SessionScanInput
each run. Two warmups +12 samples, alternating AB/BA, same bundled production
functions and Node process. GC before samples; retain graphs until timing ends,
then compare full output SHA256 outside timing. Include source hashes and raw
samples. Track scan time separately only for attribution.

Keep only primary >=10% median improvement and delta >2maxMAD, no guard >10%
regression beyond noise. No content or graph loss; preserve last duplicate-ID
winner, duplicate child order, cycles, late/orphan parent insertion, failed read
retry, watch single-file freshness, and fresh input snapshots. No global cache,
cache TTL, persisted format, dependency or concurrency change. Memory snapshots
are diagnostics; investigate any median heap increase exceeding 10 MiB.
