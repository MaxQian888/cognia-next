---
"cognia-next": patch
---

Third-party plugins that name their icons the way the documentation told them to will keep installing. The plugin contract published a kebab-case allowlist — `file-text`, `panel-right`, `message-square` and eight more — and when that constant was replaced by a direct lookup against `lucide-react`, whose keys are PascalCase, every one of those names became a fatal manifest error. A plugin you already had installed would start failing to load, and a new one written against the published list would refuse to install, with nothing to explain that only the spelling had changed.

The old spelling is now accepted with a warning that names its replacement, and the same normalization runs where icons are rendered, so a plugin pinned to `file-text` shows its icon instead of a blank space. Exact matches are always tried first, so no name that already worked changes meaning, and a name that resolves neither way is still rejected — quoted exactly as the author wrote it.

First-party plugins were already on the new spelling and are unaffected.
