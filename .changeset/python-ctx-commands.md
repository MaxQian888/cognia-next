---
"cognia-next": minor
---

Python plugins can now use `ctx.commands` and `ctx.templates`, and a python plugin's `manifest.commands` slash commands reach its `@hook("onCommand")` handler as one structured invocation through the new commands bridge.
