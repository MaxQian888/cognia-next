---
"cognia-next": patch
---

Fix Pi (pi-rpc) sessions failing every model request on OpenAI-compatible providers when an enabled plugin exposes a dotted tool name (e.g. `ocr.extract`). Cognia's Pi extension now advertises provider-safe tool names (dots rewritten to underscores) while dispatching the real MCP name, so `pi-rpc` with commandcode/DeepSeek and similar gateways can use the full Cognia tool surface again.
