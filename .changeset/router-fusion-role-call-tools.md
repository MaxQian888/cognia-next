---
"cognia-next": patch
---

Router + Fusion: a panel candidate can now actually use its evidence tools. A role call offers the step's tool policy to the model and returns the tool requests it makes, so the run's tool runtime executes them and an `evidence_review` panel can reach an accepted answer instead of at best a degraded one. Role prompts are also sent the way the AI SDK 7 runtime requires, and the tool requests are committed with the call, so a run resumed after a crash replays them instead of paying for the step twice.
