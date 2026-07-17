---
"cognia-next": patch
---

Fix the Xiaomi TTS API key being silently dropped on the desktop app after a refresh or restart. The Rust keyring's known-provider list was missing `xiaomi`, so its key was never re-enumerated at boot and got overwritten. The key now persists, and a parity test pins the Rust list to the TypeScript source so a future provider can't regress the same way.
