---
"cognia-next": patch
---

The MCP server enable/disable and tool-rule commands a paired client sends now carry a published request contract. Without one the generated API artifacts could not be rebuilt at all, which had quietly frozen the companion command catalog five commands behind the app — so a remote client asking for any of them was answered "unknown command".
