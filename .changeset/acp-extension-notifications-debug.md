---
"cognia-next": patch
---

cli: stop warning on `_`-prefixed ACP extension notifications

External agents (e.g. the Devin backend) emit vendor-namespaced JSON-RPC
extension methods such as `_cognition.ai/output`, `_cognition.ai/turn_stats`,
and `_cognition.ai/agent_stopped`. These are optional parallel metadata, not
protocol drift — but every one hit the `default:` branch's
"Unknown notification type" warning, flooding stderr with ~25 lines per turn
on `cognia-agent run`. `_`-prefixed methods (and `_`-prefixed sessionUpdate
kinds) now log at debug instead; genuinely unknown standard method names
still warn.
