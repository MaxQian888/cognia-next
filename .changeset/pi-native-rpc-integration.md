---
"cognia-next": minor
---

Add native Pi support via a new built-in `pi-rpc` protocol that drives `pi --mode rpc` directly, replacing the community `pi-acp` ACP bridge. Thinking levels, steering and follow-up, compaction, session forks and usage detail now survive instead of being flattened onto ACP. Pi's native tools run under Cognia's permission modes through a bundled, SHA-256-pinned extension, Pi session history imports (including abandoned branches), and existing `pi-acp` agents can be migrated in place — reversibly — without changing their agent id.
