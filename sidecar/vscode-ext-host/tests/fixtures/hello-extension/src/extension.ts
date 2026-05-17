/**
 * Source for the hello-extension fixture.
 *
 * The cognia VS Code reuse sidecar tests run against the compiled
 * `out/extension.js` (a tiny pre-built CJS file checked in next to this
 * source so the test suite has no build step). This .ts file exists for
 * humans — if you change behaviour, edit both.
 *
 * The shape mirrors a real VS Code extension's `activate` / `deactivate`
 * contract precisely so the sidecar's require-hook + extension-runner
 * exercise the same code paths a real extension would.
 */

import type * as vscode from "vscode"

export interface HelloExtensionExports {
  /** Greeting string returned by the hello.world command. */
  lastGreeting: string | null
  /** Number of times activate() has been called. Lifecycle invariant: <= 1. */
  activateCount: number
}

const state: HelloExtensionExports = {
  lastGreeting: null,
  activateCount: 0,
}

export function activate(context: vscode.ExtensionContext): HelloExtensionExports {
  state.activateCount += 1

  const disposable = context.subscriptions.push.bind(context.subscriptions)
  disposable(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require("vscode") as any).commands.registerCommand("hello.world", () => {
      const config = (
        require("vscode") as {
          workspace: { getConfiguration: (s: string) => { get: (k: string, d: string) => string } }
        }
      ).workspace.getConfiguration("hello")
      const greeting = config.get("greeting", "Hello")
      state.lastGreeting = `${greeting}, world!`
      return state.lastGreeting
    })
  )

  return state
}

export function deactivate(): void {
  state.lastGreeting = null
}
