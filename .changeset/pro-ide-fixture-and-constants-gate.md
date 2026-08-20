---
"cognia-next": patch
---

Adds a "Pro IDE Contribution (fixture)" plugin that exercises the managed Pro IDE pathway end to end — enable it on the desktop and every file gets a CodeLens on line 1 whose click calls back into the plugin, which is a one-glance check that proxy generation, signing, side-loading, the broker handshake and the provider round-trip are all working. Also adds a gate that keeps the Pro IDE's cross-language constants in lockstep (a drifted catalog hash silently disables every plugin proxy; a version bumped in one place silently never installs), and settles the extension on one name — the packaged file is now `cognia-managed-broker.vsix`, matching the extension it has always contained.
