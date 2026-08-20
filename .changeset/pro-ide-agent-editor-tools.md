---
"cognia-next": minor
---

The agent can now drive the embedded Pro IDE, not just look at it. Five new tools — open a file, reveal it in the explorer, show proposed contents in VS Code's native diff view for review, reflect a file it just wrote as an undo-able edit, and flush your unsaved buffers — join the existing read-only `read_active_editor`. Consent is tiered rather than uniform: the four that only move your viewport or reflect a write that already happened run without prompting, while flushing your own unsaved edits asks first, and any of it can be overridden in Settings → Agent → Permissions. The write tools appear only where the Pro IDE can actually run; reading the active editor still works with either editor engine.
