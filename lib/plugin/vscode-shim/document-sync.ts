/**
 * Keeps every VS Code extension host's view of open documents and editors
 * in step with Monaco.
 *
 * Extensions read `workspace.textDocuments`, `window.activeTextEditor` and
 * the open / change / close events, and their providers are called with the
 * document they are about. The host keeps those documents (its
 * `documents.ts`); this module tells it what changed, from the bridge's
 * editor events:
 *
 *   - `workspace:documentOpened` `{uri, languageId, version, text}`, the
 *     first time any editor shows a model;
 *   - `workspace:documentChanged` `{uri, version, text}` on every edit;
 *   - `workspace:documentClosed` `{uri}` when the last editor on it goes;
 *   - `window:editorsChanged` `{editors, activeId}` whenever the set of
 *     editors, the focused one, or a selection changes.
 *
 * Each host gets the reports in order through its own queue, so an edit
 * never overtakes the open before it. A host that starts later is brought
 * up to date with {@link DocumentSync.replay} before its extension
 * activates. A provider call names the version it was made against, and the
 * host waits for that edit, so a call never sees older text than Monaco did.
 */

import { loggers } from "@cognia/logging"

import type { MonacoEditor, MonacoEditorChangeEvent } from "./monaco-bridge"

const log = loggers.plugin.child("vscode-document-sync")

export interface DocumentSyncDependencies {
  /** Send one report to a host; resolves once the host has applied it. */
  send(pluginId: string, method: string, payload: unknown): Promise<unknown>
  /** The hosts running now. */
  hosts(): string[]
  getEditor(editorId: string): MonacoEditor | undefined
  getActiveEditorId(): string | null
  onEditorChange(listener: (event: MonacoEditorChangeEvent) => void): () => void
  onActiveEditorChanged(listener: (editor: MonacoEditor | null) => void): () => void
}

interface OpenDocument {
  languageId: string
  version: number
  text: string
  editors: Set<string>
}

interface WireEditor {
  id: string
  uri: string
  selections: Array<{
    anchor: { line: number; character: number }
    active: { line: number; character: number }
  }>
}

export interface DocumentSync {
  /** Bring a newly started host up to date: every open document, then the editors. */
  replay(pluginId: string): Promise<void>
  /** Drop a host's queue once it has stopped. */
  forget(pluginId: string): void
  /** The documents every host currently sees, for tests and diagnostics. */
  openDocuments(): string[]
  dispose(): void
}

function selectionsOf(editor: MonacoEditor): WireEditor["selections"] {
  const toWire = (position: { lineNumber: number; column: number }) => ({
    line: position.lineNumber - 1,
    character: position.column - 1,
  })
  const selections = editor.getSelections?.()
  if (selections && selections.length > 0) {
    return selections.map((selection) => ({
      anchor: toWire(selection.anchor),
      active: toWire(selection.active),
    }))
  }
  const range = editor.getSelection()
  if (range) {
    return [
      {
        anchor: toWire({ lineNumber: range.startLineNumber, column: range.startColumn }),
        active: toWire({ lineNumber: range.endLineNumber, column: range.endColumn }),
      },
    ]
  }
  const position = editor.getPosition()
  const at = position ? toWire(position) : { line: 0, character: 0 }
  return [{ anchor: at, active: at }]
}

export function createDocumentSync(deps: DocumentSyncDependencies): DocumentSync {
  const documents = new Map<string, OpenDocument>()
  /** editor id → the URI it shows. */
  const editorUris = new Map<string, string>()
  const queues = new Map<string, Promise<unknown>>()

  function enqueue(pluginId: string, method: string, payload: unknown): Promise<void> {
    const previous = queues.get(pluginId) ?? Promise.resolve()
    const next = previous
      .then(() => deps.send(pluginId, method, payload))
      .catch((error: unknown) => {
        // A host that cannot take the report is crashing or stopping; its
        // supervisor deals with that, and a restarted host is replayed.
        log.debug("VS Code document report not delivered", {
          pluginId,
          method,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    queues.set(pluginId, next)
    return next.then(() => undefined)
  }

  function broadcast(method: string, payload: unknown): void {
    for (const pluginId of deps.hosts()) void enqueue(pluginId, method, payload)
  }

  function openedPayload(uri: string, document: OpenDocument) {
    return { uri, languageId: document.languageId, version: document.version, text: document.text }
  }

  function editorsPayload(): { editors: WireEditor[]; activeId: string | null } {
    const editors: WireEditor[] = []
    for (const [id, uri] of editorUris) {
      const editor = deps.getEditor(id)
      if (editor) editors.push({ id, uri, selections: selectionsOf(editor) })
    }
    const activeId = deps.getActiveEditorId()
    return { editors, activeId: activeId && editorUris.has(activeId) ? activeId : null }
  }

  function readModel(editorId: string) {
    const model = deps.getEditor(editorId)?.getModel()
    if (!model || model.isDisposed()) return null
    return model
  }

  function onOpen(event: MonacoEditorChangeEvent): void {
    const model = readModel(event.editorId)
    if (!model) return
    editorUris.set(event.editorId, event.uri)
    const existing = documents.get(event.uri)
    if (existing) {
      existing.editors.add(event.editorId)
    } else {
      const document: OpenDocument = {
        languageId: model.language,
        version: model.getVersionId?.() ?? 1,
        text: model.getValue(),
        editors: new Set([event.editorId]),
      }
      documents.set(event.uri, document)
      broadcast("workspace:documentOpened", openedPayload(event.uri, document))
    }
    broadcast("window:editorsChanged", editorsPayload())
  }

  function onContent(event: MonacoEditorChangeEvent): void {
    const document = documents.get(event.uri)
    const model = readModel(event.editorId)
    if (!document || !model) return
    const text = model.getValue()
    const version = model.getVersionId?.() ?? document.version + 1
    if (text === document.text && version === document.version) return
    document.text = text
    document.version = version
    broadcast("workspace:documentChanged", { uri: event.uri, version, text })
  }

  function onLanguage(event: MonacoEditorChangeEvent): void {
    const document = documents.get(event.uri)
    const model = readModel(event.editorId)
    if (!document || !model || model.language === document.languageId) return
    document.languageId = model.language
    broadcast("workspace:documentLanguageChanged", { uri: event.uri, languageId: model.language })
  }

  function onClose(event: MonacoEditorChangeEvent): void {
    editorUris.delete(event.editorId)
    const document = documents.get(event.uri)
    if (document) {
      document.editors.delete(event.editorId)
      if (document.editors.size === 0) {
        documents.delete(event.uri)
        broadcast("workspace:documentClosed", { uri: event.uri })
      }
    }
    broadcast("window:editorsChanged", editorsPayload())
  }

  const unsubscribeChange = deps.onEditorChange((event) => {
    switch (event.kind) {
      case "open":
        onOpen(event)
        break
      case "change-content":
        onContent(event)
        break
      case "change-language":
        onLanguage(event)
        break
      case "change-selection":
        if (editorUris.has(event.editorId)) broadcast("window:editorsChanged", editorsPayload())
        break
      case "close":
        onClose(event)
        break
    }
  })
  const unsubscribeActive = deps.onActiveEditorChanged(() => {
    broadcast("window:editorsChanged", editorsPayload())
  })

  return {
    async replay(pluginId) {
      const pending = [...documents].map(([uri, document]) =>
        enqueue(pluginId, "workspace:documentOpened", openedPayload(uri, document))
      )
      pending.push(enqueue(pluginId, "window:editorsChanged", editorsPayload()))
      await Promise.all(pending)
    },
    forget(pluginId) {
      queues.delete(pluginId)
    },
    openDocuments() {
      return [...documents.keys()]
    },
    dispose() {
      unsubscribeChange()
      unsubscribeActive()
      documents.clear()
      editorUris.clear()
      queues.clear()
    },
  }
}
