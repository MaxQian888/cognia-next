/**
 * `vscode.commands` — register / execute / list commands.
 *
 * All three flow through the renderer's `lib/plugin/commands/registry.ts`
 * unified bus. The sidecar tracks per-extension tokens so we can clean
 * up on deactivate.
 */

import { Disposable } from "./types"
import type { ShimDependencies } from "./index"

interface SidecarCommandsApi {
  registerCommand(
    command: string,
    callback: (...args: unknown[]) => unknown,
    thisArg?: unknown
  ): Disposable
  registerTextEditorCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable
  executeCommand<T = unknown>(command: string, ...rest: unknown[]): Promise<T>
  getCommands(filterInternal?: boolean): Promise<string[]>
}

const REGISTERED_TOKENS = new WeakMap<object, Set<string>>()

export function createCommandsNamespace(deps: ShimDependencies): SidecarCommandsApi {
  const { connection, extensionId, registerProviderCallback } = deps
  const owner = {} // unique key per shim
  REGISTERED_TOKENS.set(owner, new Set())

  return {
    registerCommand(command, callback, thisArg): Disposable {
      // Each command gets a callback token the renderer uses to invoke us.
      const token = `cmd:${extensionId}:${command}`
      const unsubscribe = registerProviderCallback(token, async (payload) => {
        const args = Array.isArray(payload) ? payload : []
        try {
          return await Promise.resolve(callback.apply(thisArg ?? null, args))
        } catch (err) {
          throw err
        }
      })
      void connection
        .sendRequest("commands:register", { extensionId, command, token })
        .catch((err) => {
          process.stderr.write(
            `[vscode-shim] commands:register failed for "${command}": ${err.message ?? err}\n`
          )
        })
      REGISTERED_TOKENS.get(owner)!.add(token)
      return new Disposable(() => {
        unsubscribe()
        REGISTERED_TOKENS.get(owner)!.delete(token)
        void connection.sendNotification("commands:unregister", { extensionId, command })
      })
    },

    registerTextEditorCommand(command, callback): Disposable {
      // VS Code's TextEditor flavour just prefixes the editor as the first
      // arg. We forward through the same path.
      return this.registerCommand(command, callback)
    },

    executeCommand<T>(command: string, ...rest: unknown[]): Promise<T> {
      return connection.sendRequest<T>("commands:execute", {
        extensionId,
        command,
        args: rest,
      })
    },

    getCommands(filterInternal = false): Promise<string[]> {
      return connection.sendRequest<string[]>("commands:list", { filterInternal })
    },
  }
}
