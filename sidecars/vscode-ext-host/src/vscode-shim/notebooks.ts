/**
 * `vscode.notebooks` — Tier 4 for live execution. Static rendering of
 * notebook artifacts already works via cognia's artifact preview.
 */

import { NotSupportedError, EventEmitter } from "./types"

export function createNotebooksNamespace() {
  const dummy = new EventEmitter<unknown>()
  return {
    createNotebookController(_id: string, _notebookType: string, _label: string): never {
      throw new NotSupportedError("notebooks.createNotebookController")
    },
    registerNotebookSerializer(_notebookType: string, _serializer: unknown): never {
      throw new NotSupportedError("notebooks.registerNotebookSerializer")
    },
    registerRendererMessaging(_rendererId: string): never {
      throw new NotSupportedError("notebooks.registerRendererMessaging")
    },
    onDidOpenNotebookDocument: dummy.event,
    onDidChangeNotebookDocument: dummy.event,
    onDidSaveNotebookDocument: dummy.event,
    onDidCloseNotebookDocument: dummy.event,
    notebookDocuments: [] as unknown[],
  }
}
