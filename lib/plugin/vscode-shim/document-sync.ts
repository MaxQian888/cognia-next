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
 *     editors, the focused one, a selection or the scroll position changes.
 *
 * Besides what the editors show, a host can hold detached documents only it
 * sees: files an extension opened with `openTextDocument`, untitled
 * documents and content providers' text ({@link DocumentSync.openDetached}).
 * When an editor opens one of them, the host adopts the editor's document.
 *
 * Each host gets the reports in order through its own queue, so an edit
 * never overtakes the open before it. An editors report still waiting at
 * the end of a queue is replaced by a newer one rather than followed by it.
 * A host that starts later is brought up to date with
 * {@link DocumentSync.replay} before its extension activates. A provider
 * call names the version it was made against, and the host waits for that
 * edit, so a call never sees older text than Monaco did.
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

interface WireRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

interface WireEditor {
  id: string
  uri: string
  selections: Array<{
    anchor: { line: number; character: number }
    active: { line: number; character: number }
  }>
  visibleRanges?: WireRange[]
  options?: { tabSize: number; insertSpaces: boolean }
}

/** A document's text as the hosts know it. */
export interface SyncedDocument {
  languageId: string
  version: number
  text: string
}

export interface DocumentSync {
  /** Bring a newly started host up to date: every open document, then the editors. */
  replay(pluginId: string): Promise<void>
  /** Drop a host's queue once it has stopped. */
  forget(pluginId: string): void
  /** The documents every host currently sees, for tests and diagnostics. */
  openDocuments(): string[]
  /** The document an editor shows at `uri`, if any. */
  editorDocument(uri: string): SyncedDocument | undefined
  /**
   * Give one host a document no editor shows (`workspace.openTextDocument` of
   * a file, an untitled document, a content provider's text). Resolves with
   * its version once the host has it. Only that host sees it.
   */
  openDetached(pluginId: string, uri: string, languageId: string, text: string): Promise<number>
  /** Replace a host's detached document; resolves with its new version, or `undefined` when it has none. */
  changeDetached(pluginId: string, uri: string, text: string): Promise<number | undefined>
  /** Close a host's detached document. */
  closeDetached(pluginId: string, uri: string): void
  detached(pluginId: string, uri: string): SyncedDocument | undefined
  /** The hosts holding a detached document at `uri`. */
  detachedHolders(uri: string): string[]
  /** The detached documents a host holds. */
  heldBy(pluginId: string): string[]
  /** Tell the hosts that see `uri` it was saved (`onDidSaveTextDocument`). */
  saved(uri: string): void
  dispose(): void
}

/**
 * Detached documents a host keeps at most. VS Code drops documents no
 * editor shows once nothing holds them; a host here keeps its most recent
 * ones and closes the oldest past this.
 */
export const MAX_DETACHED_DOCUMENTS = 64

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
  /**
   * Per host, an editors report still waiting at the end of its queue.
   * Selections and scrolling report often; a newer report replaces a waiting
   * one instead of queueing behind it, so a busy host only gets the latest.
   */
  const waitingEditors = new Map<string, { payload: unknown }>()
  /** Per host, the documents only it sees, oldest first. */
  const detachedByHost = new Map<string, Map<string, SyncedDocument>>()

  function enqueue(pluginId: string, method: string, payload: unknown): Promise<void> {
    const waiting = waitingEditors.get(pluginId)
    if (method === "window:editorsChanged" && waiting) {
      waiting.payload = payload
      return queues.get(pluginId)!.then(() => undefined)
    }
    const entry = { payload }
    if (method === "window:editorsChanged") waitingEditors.set(pluginId, entry)
    else waitingEditors.delete(pluginId)
    const previous = queues.get(pluginId) ?? Promise.resolve()
    const next = previous
      .then(() => {
        if (waitingEditors.get(pluginId) === entry) waitingEditors.delete(pluginId)
        return deps.send(pluginId, method, entry.payload)
      })
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
      if (!editor) continue
      const visibleRanges = editor.getVisibleRanges?.()
      const options = editor.getOptions?.()
      editors.push({
        id,
        uri,
        selections: selectionsOf(editor),
        ...(visibleRanges && visibleRanges.length > 0
          ? {
              visibleRanges: visibleRanges.map((range) => ({
                start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
              })),
            }
          : {}),
        ...(options ? { options } : {}),
      })
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
      // A host holding it detached adopts the editor's text and version.
      for (const held of detachedByHost.values()) held.delete(event.uri)
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

  function detachedOf(pluginId: string): Map<string, SyncedDocument> {
    let held = detachedByHost.get(pluginId)
    if (!held) {
      held = new Map()
      detachedByHost.set(pluginId, held)
    }
    return held
  }

  async function changeDetached(
    pluginId: string,
    uri: string,
    text: string
  ): Promise<number | undefined> {
    const document = detachedByHost.get(pluginId)?.get(uri)
    if (!document) return undefined
    if (document.text === text) return document.version
    document.text = text
    document.version += 1
    const version = document.version
    await enqueue(pluginId, "workspace:documentChanged", { uri, version, text })
    return version
  }

  return {
    async replay(pluginId) {
      // A newly started host has none of its old detached documents.
      detachedByHost.delete(pluginId)
      const pending = [...documents].map(([uri, document]) =>
        enqueue(pluginId, "workspace:documentOpened", openedPayload(uri, document))
      )
      pending.push(enqueue(pluginId, "window:editorsChanged", editorsPayload()))
      await Promise.all(pending)
    },
    forget(pluginId) {
      queues.delete(pluginId)
      waitingEditors.delete(pluginId)
      detachedByHost.delete(pluginId)
    },
    openDocuments() {
      return [...documents.keys()]
    },
    editorDocument(uri) {
      const document = documents.get(uri)
      return document
        ? { languageId: document.languageId, version: document.version, text: document.text }
        : undefined
    },
    async openDetached(pluginId, uri, languageId, text) {
      const shown = documents.get(uri)
      if (shown) return shown.version
      const held = detachedOf(pluginId)
      const existing = held.get(uri)
      if (existing) {
        if (existing.text === text) return existing.version
        return (await changeDetached(pluginId, uri, text)) ?? existing.version
      }
      const document: SyncedDocument = { languageId, version: 1, text }
      held.set(uri, document)
      const pending = [enqueue(pluginId, "workspace:documentOpened", { uri, ...document })]
      while (held.size > MAX_DETACHED_DOCUMENTS) {
        const oldest = held.keys().next().value as string
        held.delete(oldest)
        pending.push(enqueue(pluginId, "workspace:documentClosed", { uri: oldest }))
      }
      await Promise.all(pending)
      return document.version
    },
    changeDetached,
    closeDetached(pluginId, uri) {
      if (detachedByHost.get(pluginId)?.delete(uri)) {
        void enqueue(pluginId, "workspace:documentClosed", { uri })
      }
    },
    detached(pluginId, uri) {
      const document = detachedByHost.get(pluginId)?.get(uri)
      return document ? { ...document } : undefined
    },
    detachedHolders(uri) {
      return [...detachedByHost].filter(([, held]) => held.has(uri)).map(([pluginId]) => pluginId)
    },
    heldBy(pluginId) {
      return [...(detachedByHost.get(pluginId)?.keys() ?? [])]
    },
    saved(uri) {
      if (documents.has(uri)) {
        broadcast("workspace:documentSaved", { uri })
        return
      }
      for (const [pluginId, held] of detachedByHost) {
        if (held.has(uri)) void enqueue(pluginId, "workspace:documentSaved", { uri })
      }
    },
    dispose() {
      unsubscribeChange()
      unsubscribeActive()
      documents.clear()
      editorUris.clear()
      queues.clear()
      waitingEditors.clear()
      detachedByHost.clear()
    },
  }
}
