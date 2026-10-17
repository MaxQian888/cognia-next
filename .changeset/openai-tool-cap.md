---
"cognia-next": patch
---

Keep OpenAI-compatible requests under the provider's tool-definition cap (128, or a lower one the upstream reports): sessions with more tools keep the core file and shell tools loaded, load the rest on demand through ToolSearch, and show a warning, instead of failing with "tools must contain at most 128 function definitions".
