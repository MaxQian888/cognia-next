---
"cognia-next": minor
---

Thinking level for Devin backends. `devin acp` publishes no `thought_level` config option — its reasoning ladder is encoded in the model ids themselves (`claude-opus-5-low` … `claude-opus-5-max`, `gpt-5-6-sol-none` … `gpt-5-6-sol-xhigh`, `swe-1-7` → "SWE-1.7 Max"). `DevinAcpAdapter` now synthesizes a `thought_level` select over the model family the session is on (serving tiers like `-fast`/`-1m` and fusion sidekick pairings stay fixed), and a level write becomes a model-variant switch through the existing `session/set_config_option` path. The capability manifest records this as `equivalent` via `modelVariantOverlay` (the generic ACP row moves from `unsupported` to `unknown`, since `thought_level` is a real — but per-session — protocol slot), and the CLI forwards the configured thinking level on the shared `reasoningEffort` channel for every non-Codex preset, so `/think` now works on Devin instead of reporting "the agent protocol has no equivalent".
