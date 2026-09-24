---
"cognia-next": patch
---

Laya plugin (renamed "Laya (local System-1)") no longer stalls inbound IM messages on first run: `checkpoint: auto` now preloads the english + multilingual checkpoints on a background thread before reporting ready, inference runs under its own lock so status/config never wait on a forward pass, a checkpoint switch mid-load can no longer publish the old model, failed loads back off for 5 minutes (retry via `laya_status retry=true` or a config save), `blocks` counts only messages actually dropped, and `laya_decide` trims the oldest chat messages to fit the checkpoint budget and reports what laya would otherwise have cut silently.
