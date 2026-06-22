"use strict"

function activate(context) {
  const vscode = require("vscode")
  const commandId = "cogniaPluginTemplate.hello"
  const disposable = vscode.commands.registerCommand(commandId, () => {
    void vscode.window.showInformationMessage("Hello from Cognia Plugin Template VS Code Extension")
  })
  context.subscriptions.push(disposable)
  return {
    registeredCommands: [commandId],
    registeredWebviewViews: [],
    registeredLanguageProviders: [],
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
