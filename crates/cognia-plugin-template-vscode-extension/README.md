# Cognia VS Code-extension plugin template

This starter is emitted by:

```bash
cognia plugin new my-vscode-plugin --kind vscode
```

The host loads `extension/out/extension.js` from `plugin.json`'s `vscodeMain` field and runs it through the Cognia VS Code sidecar, which supplies a shim of the `vscode` module. The sample exports `activate` and `deactivate` and ships `package.json` through `bundle_include`.

What it registers:

| API                                        | Shows                                                    |
| ------------------------------------------ | -------------------------------------------------------- |
| `commands.registerCommand`                 | a command, also declared in `package.json` `contributes` |
| `workspace.getConfiguration`               | settings, declared in `contributes.configuration`        |
| `languages.registerCompletionItemProvider` | a language provider                                      |

Three differences from real VS Code:

1. Settings declared in `contributes.configuration` appear on the plugin's
   settings page, and `getConfiguration().get(key, default)` reads them
   synchronously, as in VS Code: the user's value, else the declared default,
   else the one you pass. `workspace.onDidChangeConfiguration` follows changes.
2. `activate` must return `{ registeredCommands, registeredWebviewViews,
registeredLanguageProviders }`. The host reads that summary to know what the
   extension contributed.
3. **Not every `vscode` namespace does something.** Commands, the window
   (messages, quick picks, progress, the status bar, output channels, dialogs),
   documents and editors, languages, `workspace.fs`, `findFiles`, file
   watchers, settings, `env`, `extensions`, terminals (tabs in the terminal
   dock) and webviews (tabs in the extension rail) are served. `debug`, `scm`,
   `tests`, `notebooks` and `comments` are present but inert. Any request the
   Host does not answer yet is listed in `EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS`
   (`lib/plugin/vscode-shim/unavailable-methods.ts`) and gets a deterministic
   capability error; the list is empty today.

## Logging

Write to `console.error` or `console.warn`, never `console.log`. The extension
host speaks JSON-RPC over **stdout** and reserves stderr for diagnostics the
renderer captures verbatim (`sidecar/vscode-ext-host/src/host.ts`), so a line on
stdout corrupts the frame stream.

## Validate and package

```bash
node --check extension/out/extension.js
cognia plugin lint
cognia plugin build
```

`cognia plugin build` is build-free for VS Code-extension plugins: it validates `plugin.json`, then packages `plugin.json`, the declared `vscodeMain`, optional `styles.css`, and any `bundle_include[]` files into `target/cognia/<id>-<version>.zip`.
