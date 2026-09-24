---
"cognia-next": patch
---

Fix Pi native-RPC sessions failing the extension handshake whenever a plugin exposes a colon-namespaced tool (e.g. `ripgrep-tools:ripgrep_search`). The projected tool-name sanitizer now maps `:` to `_` (like dotted names), and handshake errors include the offending tool name.
