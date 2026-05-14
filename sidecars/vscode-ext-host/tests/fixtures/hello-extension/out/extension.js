"use strict"
// Pre-built CJS output of ../src/extension.ts. Checked in so the sidecar
// test suite has no build step. Mirror any change in the .ts file here.

const state = {
  lastGreeting: null,
  activateCount: 0,
}

function activate(context) {
  state.activateCount += 1
  const vscode = require("vscode")
  context.subscriptions.push(
    vscode.commands.registerCommand("hello.world", () => {
      const config = vscode.workspace.getConfiguration("hello")
      const greeting = config.get("greeting", "Hello")
      state.lastGreeting = `${greeting}, world!`
      return state.lastGreeting
    })
  )
  return state
}

function deactivate() {
  state.lastGreeting = null
}

module.exports = { activate, deactivate }
