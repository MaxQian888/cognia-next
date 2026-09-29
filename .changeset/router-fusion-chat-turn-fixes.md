---
"cognia-next": patch
---

Router + Fusion chat fixes: the chat breaker now trips after three turns in a row that each lost the ledger mid-turn; image-only turns are refused by Cascade and Panel (and never picked by Auto) instead of losing their images; retries, reroutes and durable replays reseal on the original turn's routing inputs and runtime lane; a replay that goes out unledgered is checked against the cost budget again; turns handed to the host are no longer sealed; the run card marks Claude Agent SDK runs as an estimated cap; every refusal the chat can show has a sentence; and recovery replays pending outbox effects at every boot.
