---
"cognia-next": patch
---

Fix the headless brain layout used by the server image and the macOS host archive: the brain no longer dies on start loading `jsonc-parser`, the agent sidecar ships the packages the Claude Agent SDK imports, and sidecar launchers start when the install path goes through a symlink.
