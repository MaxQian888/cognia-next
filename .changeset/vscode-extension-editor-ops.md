---
"cognia-next": minor
---

VS Code extensions can now work on the editor itself: `TextEditor.edit` and `insertSnippet` change the text (refused when the document moved on, as in VS Code), decoration types draw colors, borders, whole-line backgrounds, before/after text, light/dark variants and overview-ruler marks, `revealRange`, setting `selections` and `options` move the real editor, and extensions see the editor's visible ranges and indentation with their change events. A decoration's gutter or content icon and cursor style are not drawn yet.
