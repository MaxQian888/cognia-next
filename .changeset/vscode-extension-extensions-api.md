---
"cognia-next": patch
---

VS Code extensions can now see each other: `extensions.all` and `getExtension` list the installed VS Code extensions (case-insensitive ids) with their `packageJSON`, install location and whether they are running, `onDidChange` fires when that changes, and an extension's own entry carries its exports. `activate()` on another extension resumes or waits for it, and fails for one the user disabled. Another extension's `exports` are not available, because each extension runs in its own process.
