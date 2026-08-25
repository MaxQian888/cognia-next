---
"cognia-next": patch
---

Lost log and telemetry entries now say why they were lost. Every transport already counted its drops and surfaced the total in /logs, but a single number could not tell "the collector is unreachable" from "we are producing faster than we can ship" from "the app shut down mid-flush" — all three read as the same integer, so an operator learned that something was lost and nothing about what to do. Drops are now attributed to a closed set of reasons (ship failed, buffer overflow, entry rejected, discarded at shutdown, removed by retention) alongside the existing total, with an invariant that the two agree. On the native side, the startup sweep of rotated log files records how many it deleted instead of discarding the count, so retention can finally say what it cost.
