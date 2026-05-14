/**
 * `vscode.terminal` — convenience namespace duplicating
 * `window.createTerminal` and exposing global terminal events.
 */

import { EventEmitter } from "./types"
import type { ShimDependencies } from "./index"

export function createTerminalNamespace(deps: ShimDependencies) {
  const { connection } = deps
  const openEmitter = new EventEmitter<unknown>()
  const closeEmitter = new EventEmitter<unknown>()
  const changeActiveEmitter = new EventEmitter<unknown>()
  connection.onNotification("terminal:open", (data) => openEmitter.fire(data))
  connection.onNotification("terminal:close", (data) => closeEmitter.fire(data))
  connection.onNotification("terminal:activeChanged", (data) => changeActiveEmitter.fire(data))
  return {
    onDidOpenTerminal: openEmitter.event,
    onDidCloseTerminal: closeEmitter.event,
    onDidChangeActiveTerminal: changeActiveEmitter.event,
    terminals: [] as unknown[],
    activeTerminal: undefined as unknown,
  }
}
