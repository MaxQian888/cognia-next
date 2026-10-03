"use strict"
// Exercises what the host hands an extension: the context's URIs and mode,
// a persisted memento, the gated `fs` module, and `vscode` from a nested
// module. Activation returns what it saw so the test can assert on it.

function tryRequire(name) {
  try {
    require(name)
    return "granted"
  } catch (error) {
    return error.code === "EPERM" ? "denied" : `failed: ${error.message}`
  }
}

async function activate(context) {
  const vscode = require("vscode")
  await context.globalState.update(
    "activations",
    (context.globalState.get("activations", 0) || 0) + 1
  )
  return {
    vscodeVersion: vscode.version,
    nestedVersion: require("./lib/nested").version(),
    extensionUri: context.extensionUri.toString(),
    extensionPath: context.extension.extensionPath,
    packageName: context.extension.packageJSON.name,
    globalStorage: context.globalStorageUri.fsPath,
    storage: context.storageUri ? context.storageUri.fsPath : null,
    mode: context.extensionMode,
    productionMode: vscode.ExtensionMode.Production,
    activations: context.globalState.get("activations"),
    fs: tryRequire("fs"),
    childProcess: tryRequire("child_process"),
    hasLocation: typeof vscode.Location === "function",
  }
}

module.exports = { activate }
