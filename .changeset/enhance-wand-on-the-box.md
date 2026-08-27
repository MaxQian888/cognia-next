---
"cognia-next": minor
---

Composer: the prompt-enhance wand moves out of the `+` menu and onto the input box itself, as an icon button beside the save-as-template bookmark — it rewrites what is in the box, so it now appears (with the bookmark) as soon as there is a draft to act on, instead of hiding behind a menu. The box's corner controls became a real slot system: they fill right-to-left and the text's trailing inset grows with them, so three controls no longer print over the first line.

Settings → Conversation → Composer AI assistance gains the assistance-model picker: `composerAssistance.model` was read by all four helpers (enhance, inline autocomplete, starter and follow-up suggestions) and writable by nobody, which left no way to point them at a provider the app actually holds a key for. And the wand's "no model" toast now carries an action that opens provider settings instead of dead-ending.
