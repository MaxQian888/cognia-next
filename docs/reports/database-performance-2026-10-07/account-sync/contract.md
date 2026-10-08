# Account pull experiment — 2026-10-07

Hypothesis: deriving the same epoch op subkey for every incoming op is redundant.
Candidate: one subkey per epoch per apply call; preserve sequential origin verification,
decryption, batch atomicity, field merges, cursor commits and inbox parking.
Baseline saved from the current shared tree before production edits. Candidate exists
only as a benchmark source snapshot until the result meets the decision rule.

User path: received signed/encrypted ops → verification/decryption → encrypted IndexedDB
writes and durable cursor completion. Excludes network fetch and UI rendering.
Fixture: 1 and 300 session-title upserts, one epoch; fresh disposable native IndexedDB
schema with actual content-encryption + account capture middleware; local WebCrypto
signatures, ciphertext and keys. Initial preparation/signing excluded from timing.
Build: esbuild minified browser bundles, identical toolchain for baseline/candidate.
Platform: headless Chromium on local Apple M4 Pro (environment.json); no live user data.
Warmup: 1 paired run per workload. Samples: 15 paired runs, alternating AB/BA order.
Primary: completion duration median milliseconds; noise: MAD.
Keep only if 300-op median improves >=10% AND delta >2×larger MAD.
Guardrails: 1-op regression <= max(10% baseline, 1ms); rows, field clocks, cursor,
applied count and empty outgoing queue exactly equal; no changed schema or durability.
Measurements use bounded sequential crypto, no additional concurrency or global key cache.
Raw evidence: browser-results.json. Temporary bundles/server under /tmp, isolated browser.
