# Outbound queue read experiment — 2026-10-07

User outcome: load five status groups for the offline outbound queue sheet, flatten and order exactly as its live query. Actual `listByStatus` API on native Chromium IndexedDB and actual encryption middleware/policy; the mobileOutboundQueue table is metadata-only by current app policy. Real transport/rendering/shell are outside this API timing.

Candidate: replace cursor-filtered indexed status range with same indexed `.toArray()` native getAll path followed by equivalent in-memory scope filter + stable createdAt sorting. Only existing mobile-outbound-queue module and test change; no API, schema, capture, claim, retry or status transitions change.

Cases predeclared: small 10; typical backlog 1000; stress backlog 5000; foreign-heavy 5000 with only 1% belonging to current scope. Five statuses evenly distributed; 1 KiB deterministic payload per job; includes alternate-account, alternate-target and legacy-mixed targets plus createdAt ties. Includes deadlettered legacy visibility. Extra sent/failed records verify status exclusion. Payload total <=~6 MiB across all matching statuses at this declared largest shape. Native getAll can temporarily retain foreign rows current cursor filter discards. No unlimited-memory claim; record fetched/returned counts and JSON bytes, avoid simultaneous >5000-row test. Worst-case memory grows with same-status foreign backlog; no new persistent cache.

2 warmups +15 samples per variant, warm same DB and browser; alternate baseline/result order. Native IDB fixture reset only between workloads. Baseline measured BEFORE production edit; baseline source snapshot retained for paired remeasurement. Exact complete ordered row equality vs baseline and independent scope/order invariant; no DB mutation. Small/foreign guardrails: no regression >10% AND >2maxMAD. Primary stress succeeds only >=10% AND absolute saving >2maxMAD. Hardware same; exclusive timing lane from root.

Allowed side effects: own report files and temp minified browser bundle/server, synthetic isolated DB/ephemeral key/browser; no user DB/network/credentials. Tests: scoped existing queue suite + cases for timestamp ties, mixed target and null-scope behavior; parent handles broader regression/lint/typecheck.

Implementation refinement before source edit: retain Dexie's existing `sortBy("createdAt")` comparator exactly, but move scope filtering after that native range read/sort. This avoids reimplementing comparator/tie rules. Sorting also includes foreign rows transiently, measured by foreign-heavy guardrail.
