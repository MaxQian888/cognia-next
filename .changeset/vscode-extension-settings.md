---
"cognia-next": minor
---

VS Code extensions' settings now work. Settings an extension declares in `contributes.configuration` appear on its Configure tab (titles, descriptions, enums, bounds and patterns included, with `package.nls` text resolved), and `workspace.getConfiguration` reads them synchronously as in VS Code: the user's value, else the declared default, with whole sections readable as objects, `has`, `inspect`, and VS Code's defaults for common core settings. `update` saves the extension's own settings and resolves once the new value is visible, and `onDidChangeConfiguration` reports which settings changed, including edits made on the Configure tab. An extension's name and description written as `%key%` now show in the user's language. Language-specific settings and `configurationDefaults` are not supported yet, and every update is saved as a user setting.
