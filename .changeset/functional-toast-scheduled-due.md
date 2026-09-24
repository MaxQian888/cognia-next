---
"cognia-next": minor
---

Scheduled-task due reminders now surface as a designed functional toast instead of a plain title line: a kind-colored card with the task's trigger summary, a last-run → now → next-run timeline, run/workspace metadata, and quiet Open · Mute · Dismiss actions. Mute writes a per-task `dueReminder` flag (task still runs; start/complete/error notifications are unaffected) that can be re-enabled from the task form's notification settings, where the muted state is now shown. Underneath is a reusable functional-toast capability — a shared chrome plus a spec factory per notification producer, resolved through a registry in the notification runtime — so other notification types can ship the same card treatment; unregistered notifications keep the existing generic Sonner style.
