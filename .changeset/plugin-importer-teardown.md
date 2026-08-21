---
"cognia-next": patch
---

Disabling or uninstalling a plugin now removes the chat importers and custom
importers it registered at runtime. Previously both survived teardown unless the
plugin happened to call its own disposer: a disabled plugin's importer kept
participating in format detection, and kept being authorized to receive the raw
bytes of any chat attachment whose extension it claimed.
