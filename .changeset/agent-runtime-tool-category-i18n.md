---
"cognia-next": patch
---

Fix crashes in the agent-runtime settings when newer built-in tool categories are shown. `codeGraph`, `astGrep`, `dependencyResearch`, and `webclone` were added to the built-in tool registry, but their labels were never added to the settings messages — so the Permissions & Tools tab threw `MISSING_MESSAGE` (e.g. `settings.agentRuntimeSection.permissions.categories.codeGraph.name`) and the Tools tab would likewise fail on `toolSettings.codeGraph`. All missing category names/descriptions are now added in both locales, and a registry test asserts every built-in tool category resolves its permission-tab and tools-tab labels in `en` and `zh-CN` so this class of drift can't regress.
