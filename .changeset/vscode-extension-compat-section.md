---
"cognia-next": minor
---

A VS Code extension's details now list what it uses that Cognia does not provide, in a "Not available in Cognia" section: debuggers, notebooks, tree views and view containers, context menus, keyboard shortcuts, syntax grammars in the code editor (they still color code in chat and previews), the extensions an extension pack lists, and extensions built as ES modules, which cannot start. The same section names the unsupported VS Code APIs found in the extension's code and the activation events Cognia never fires. An ES module extension now fails with that reason instead of an internal note about a future phase.
