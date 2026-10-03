"use strict"

/**
 * Cognia VS Code-extension plugin template.
 *
 * This is a real CommonJS VS Code extension, run by the Cognia sidecar against
 * a shim of the `vscode` module rather than by VS Code itself. The shim covers
 * `commands`, `window`, `workspace`, `languages`, `env`, `tasks`, `debug`,
 * `scm`, `tests`, `notebooks`, `comments`, `authentication`, `chat` and `lm`,
 * so most extensions run unmodified. Three differences are worth knowing
 * before you port one:
 *
 * 1. Settings declared in `package.json` `contributes.configuration` appear
 *    on the plugin's settings page. `workspace.getConfiguration().get()`
 *    reads them synchronously, as in VS Code: the user's value, else the
 *    declared default, else the default you pass. Listen to
 *    `workspace.onDidChangeConfiguration` to follow changes.
 * 2. `activate` must return the registration summary below. The host reads it
 *    to know what this extension contributed, and an extension that returns
 *    nothing looks like one that registered nothing.
 * 3. NOT EVERY SHIMMED API HAS A HOST BEHIND IT. The shim exposes the full VS
 *    Code surface, but the Host answers only the calls it has a canonical
 *    adapter for; the rest get a deterministic capability error. The list is
 *    `EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS` in
 *    `lib/plugin/vscode-shim/unavailable-methods.ts`; webviews and terminals
 *    are on it. Some of those send their request with a bare `void`, so
 *    calling one does not merely do nothing: it raises an unhandled rejection
 *    inside the extension host. Check that list before reaching for an API.
 *
 * Logging: write to `console.error` / `console.warn`, never `console.log`.
 * The host process speaks JSON-RPC over stdout and reserves stderr for
 * diagnostics the renderer captures verbatim (`sidecar/vscode-ext-host/src/
 * host.ts`), so a line on stdout corrupts the frame stream.
 */

function activate(context) {
  const vscode = require("vscode")

  const commandId = "cogniaPluginTemplate.hello"
  const languageProviderId = "cogniaPluginTemplate.completion"

  /** See the logging note above: stdout belongs to the RPC connection. */
  const log = (message) => console.error(`[cognia-template] ${message}`)

  // The declared default applies; the one passed here is the last resort. See note 1.
  const greeting = vscode.workspace.getConfiguration("cogniaPluginTemplate").get("greeting", "Hello")

  // A command. The Host serves `commands:register` / `commands:execute`, so
  // this is reachable from the command palette and from other extensions.
  context.subscriptions.push(
    vscode.commands.registerCommand(commandId, () => {
      log(`${greeting} from the Cognia template extension`)
      return { greeting }
    })
  )

  // A language provider. `selector` is a VS Code document selector, so
  // `{ scheme: "file" }` alone would apply to every language.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { scheme: "file", language: "markdown" },
      {
        provideCompletionItems() {
          return [{ label: "cognia", detail: "Cognia template completion", kind: 14 }]
        },
      },
      ":"
    )
  )

  log("template extension activated")

  return {
    registeredCommands: [commandId],
    registeredWebviewViews: [],
    registeredLanguageProviders: [languageProviderId],
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
