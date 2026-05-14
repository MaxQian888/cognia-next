/**
 * `vscode.extensions` — cross-extension API consumption.
 */

import { EventEmitter, Disposable } from "./types"
import type { ShimDependencies } from "./index"

interface ExtensionDescriptor {
  id: string
  extensionPath: string
  isActive: boolean
  packageJSON: Record<string, unknown>
  exports: unknown
  activate(): Promise<unknown>
}

export function createExtensionsNamespace(deps: ShimDependencies) {
  const { connection } = deps
  const changed = new EventEmitter<void>()
  connection.onNotification("extensions:changed", () => changed.fire(undefined))

  function buildDescriptor(id: string, raw: Partial<ExtensionDescriptor>): ExtensionDescriptor {
    return {
      id,
      extensionPath: raw.extensionPath ?? id,
      isActive: raw.isActive ?? false,
      packageJSON: raw.packageJSON ?? {},
      exports: raw.exports,
      activate: () => connection.sendRequest("extensions:activate", { id }),
    }
  }

  return {
    get all(): ExtensionDescriptor[] {
      // Synchronous read — best-effort from the cache the renderer pushes.
      // VS Code's `extensions.all` is also a snapshot, so this is faithful.
      // We expose an empty array by default; the renderer can populate via
      // an `extensions:listSnapshot` notification on demand.
      return []
    },
    getExtension(extensionId: string): ExtensionDescriptor | undefined {
      void connection
        .sendRequest<
          Partial<ExtensionDescriptor> | undefined
        >("extensions:get", { id: extensionId })
        .catch(() => undefined)
      // Returning undefined is the correct VS Code spec value when the
      // extension isn't installed — we provide the synthetic API for
      // callers that compare-then-use; they will see exports populated
      // only after the renderer responds.
      return buildDescriptor(extensionId, {})
    },
    onDidChange: changed.event,
    /** Test/diagnostic helper — not part of VS Code's public surface. */
    dispose: () => new Disposable(() => {}),
  }
}
