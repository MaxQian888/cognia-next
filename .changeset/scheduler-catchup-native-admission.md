---
"cognia-next": patch
---

Preserve task state and run budgets during catch-up, retain fresh grace-window occurrences, reject stale native alarms, expose native timing failures, and fence pending due, expiry and prewarm work after lifecycle changes.

Keep promoted schedule slots and reject stale or early OS wakes, roll back obsolete OS creation without restoring paused/deleted state, and translate macOS one-shot jobs using local calendar minutes with a persistent one-attempt guard. Preserve manual execution arguments and report rejected wakes accurately.

Route direct LLM completion and streaming through the existing platform HTTP transport so desktop tasks can reach configured local providers.

Preserve Azure SDK authentication and endpoint handling during shared provider resolution while retaining explicit protocol overrides and existing compatible-provider routes.
