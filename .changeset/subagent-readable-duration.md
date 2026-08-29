---
"cognia-next": patch
---

Chat: sub-agent cards show a readable run time. The duration was printed as raw milliseconds, so a five-minute sub-agent read "301274ms" — unreadable, and an unbounded-width cell in a row that already competes with the name, the badges and the Stop button. It now renders as "2.4s" / "5m 1s" through the same formatter the rest of the agent UIs use, and the name reclaims the width freed on a narrow column instead of truncating while space sits unused beside it.
