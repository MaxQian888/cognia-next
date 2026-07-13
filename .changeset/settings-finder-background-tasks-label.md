---
"cognia-next": patch
---

Fix a crash in the settings command palette (⌘/Ctrl+K finder). The "Background tasks" control was registered in the finder but had no translation, so opening the settings page threw `MISSING_MESSAGE: settings.finder.controls.backgroundTasks`. The missing label is now added in both locales, and a registry test now asserts every finder control resolves to a real translation in both `en` and `zh-CN` so this can't regress.
