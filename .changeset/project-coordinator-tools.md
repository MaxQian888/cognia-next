---
"cognia-next": patch
---

Add the coordinator/thread tool family, protocol and project status (ADR-0204 groundwork): spawn_thread, propose_threads, start/message/stop/resolve_thread, list_threads, read_thread_report, remember_project_note and set_project_preference, gated on the caller's project role with a lowest-layer ruleset, plus a derived per-thread board state with a 7-day auto-resolve rule.
