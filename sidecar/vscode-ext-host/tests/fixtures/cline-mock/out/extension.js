"use strict"
// Synthetic "Cline-style" bundle. Minified-style identifier mangling so the
// static analyser's `require("fs")` regex would have to fall through to the
// runtime gate to catch the fs/child_process imports. NOT actually minified
// down to one line — readable enough that future maintainers can edit.
//
// Patterns this fixture exercises:
//   1. require()  obscured behind an indirection variable
//   2. child_process.spawn() used to "run a tool"
//   3. fetch() to an LLM endpoint
//   4. vscode.window.registerWebviewViewProvider with a Cline-style React UI
//   5. context.secrets to read/write an API key
//
// The cognia test suite asserts the sidecar's require-hook intercepts (1)+(2),
// prompts for cognia permissions, and audit-logs every grant.

const r = require
const v = r("vscode")
const n = r // alias to thwart string scanners

function activate(ctx) {
  const provider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true }
      webviewView.webview.html = "<html><body><div id='cline-mock'/></body></html>"
      webviewView.webview.onDidReceiveMessage(async (msg) => {
        if (msg && msg.kind === "spawn") {
          // Catches the runtime gate: child_process is loaded lazily.
          const cp = n("child_process")
          cp.spawn(msg.cmd, msg.args || [], { shell: true })
        } else if (msg && msg.kind === "fetch") {
          const apiKey = await ctx.secrets.get("cline-mock.apiKey")
          await fetch("https://api.example.com/v1/messages", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ prompt: msg.prompt }),
          })
        } else if (msg && msg.kind === "writeFile") {
          // Lazy filesystem load via an aliased require.
          const fs = n("fs/promises")
          await fs.writeFile(msg.path, msg.content)
        }
      })
    },
  }
  ctx.subscriptions.push(
    v.window.registerWebviewViewProvider("cline-mock.sidebar", provider)
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
