---
"cognia-next": patch
---

Fix token usage and output-speed statistics for external ACP agents (Devin CLI). The ACP client now consumes the real telemetry Devin already sends — `PromptResponse.usage` and the cumulative `cognition.ai/*` counters on `usage_update` — converting them to per-turn deltas against a baseline captured at prompt send (restored/forked sessions prime their baseline on first sighting rather than billing history to the next turn). `done` events carry the turn's token usage plus a measured `durationMs`, folded through the protocol adapter into the TUI's usage display, so the `tok/s` readout finally has both halves it needs; agents that report no counters still show context occupancy only, with no fabricated totals.

Cache read/write counters (`cognition.ai/cachedReadTokens`/`cachedWriteTokens`) flow into the usage panel's cache rows and cache-hit rate — a counter the wire reported is shown even at a zero delta, distinct from telemetry that never arrived. Devin's billing figures (`cognition.ai/totalAcuCost`, `cognition.ai/totalCreditCost`) ride the same cumulative→delta conversion and surface as a provider-denominated cost (`1.6 ACU`) in the usage panel and footer — never relabelled as USD, which stays a dollars-only figure.
