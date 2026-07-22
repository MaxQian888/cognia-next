---
"cognia-next": minor
---

Fix the Agent Fleet's Codex integration, which had never worked, and restructure the fleet around per-agent manifests so a new coding agent is a declaration instead of a refactor.

- **Codex sessions now actually appear in the island.** Codex identifies a session with `thread-id`, but the fleet only ever accepted `session_id`, so every event Codex sent was discarded before it reached the registry — while the settings card reported a healthy install the whole time. Codex is now driven by its hooks system (`~/.codex/hooks.json`) instead of `notify`, which raises it from a single turn-complete ping to the full lifecycle: tool activity, subagents, compaction, and a real blocking permission gate you can answer from the island.
- The Codex installer **merges into `hooks.json` rather than replacing it**, so other tools that already register hooks there keep working, and uninstall removes only Cognia's entries. Because Codex ties hook trust to the hook's exact command, a drifted entry is now reported as `stale` (it will not fire until reinstalled and re-approved) rather than as a healthy install.
- Each agent's event vocabulary, session-id fields, capabilities, and reply format are now declared in one place. Two consequences you can see: an unrecognized event can no longer conjure a phantom agent row, and one agent's event names can no longer be mistaken for another's.
