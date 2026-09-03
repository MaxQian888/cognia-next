---
"cognia-next": minor
---

Load unpacked now recognises Claude Code, Codex and Gemini plugin bundles. Picking one of those directories used to fail with a raw "plugin.json not found", even though the identical bundle installs fine from GitHub because that path converts it. Cognia now shows what conversion carries over, and installs the converted plugin once you approve it.
