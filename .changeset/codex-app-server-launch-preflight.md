---
"cognia-next": patch
---

Fix external-agent launch failures reported as "Failed to spawn process: No such file or directory (os error 2)". Agent CLIs installed by Homebrew, npm/pnpm/bun or cargo are now discovered even when the app's PATH omits them (a Finder-launched macOS bundle inherits only the launchd PATH), the spawn is preflighted so a missing command and a missing working directory report distinct actionable errors, and a missing CLI blocks the connect with install instructions instead of failing mid-handshake — including for hand-written stdio agents, which previously skipped the check entirely.
