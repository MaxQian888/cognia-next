---
"cognia-next": patch
---

Stop external-agent logs from surfacing codex-cli's self-healing model-cache diagnostics as host warnings. codex forwards its own `tracing` output to stderr, and the external-agent reader logged every stderr line at WARN — so a stale-schema `~/.codex/models_cache.json` (written by a previous codex version, missing a now-required field such as `supports_reasoning_summaries`) produced a repeating `ERROR codex_models_manager::cache: failed to load models cache …` WARN even though codex refetches and heals the cache on the next TTL/version check. Those known-transient cache load/renew lines are now demoted to DEBUG; genuine agent errors still log at WARN, and every line is still forwarded to the UI event stream unchanged.
