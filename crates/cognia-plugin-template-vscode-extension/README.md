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

1. `getConfiguration().get(key, default)` answers with the default and refreshes
   in the background, because the shim is async under a synchronous API. Always
   pass a default and re-read rather than caching the first value.
2. `activate` must return `{ registeredCommands, registeredWebviewViews,
registeredLanguageProviders }`. The host reads that summary to know what the
   extension contributed.
3. **The shim exposes more of `vscode` than the Host answers.** The Host serves
   only the calls it has a canonical adapter for; the rest return a
   deterministic capability error, and some send their request with a bare
   `void`, so calling one raises an unhandled rejection inside the extension
   host rather than merely doing nothing. The refused list is
   `EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS` in
   `lib/plugin/vscode-shim/runtime-handlers.ts` — check it before reaching for
   an API. It currently includes the surfaces an extension reaches for first:

   | Not available yet                                    | Instead                                                             |
   | ---------------------------------------------------- | ------------------------------------------------------------------- |
   | `window.createOutputChannel`                         | `console.error` / `console.warn` (see below)                        |
   | `window.createStatusBarItem`                         | — no host status bar surface exists                                 |
   | `window.showInformationMessage` and its siblings     | — no host message surface exists                                    |
   | `window.createWebviewPanel`, `window.createTerminal` | — see the list for the full set                                     |
   | `workspace.onDidSaveTextDocument`                    | — the notification has no host emitter, so the listener never fires |

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
