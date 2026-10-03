import {
  createDocumentSync,
  MAX_DETACHED_DOCUMENTS,
  type DocumentSyncDependencies,
} from "./document-sync"
import type { MonacoEditor, MonacoEditorChangeEvent } from "./monaco-bridge"

function makeEditor(id: string, uri: string) {
  const state = { text: "one", version: 1, language: "typescript" }
  const editor: MonacoEditor = {
    id,
    getModel: () => ({
      uri,
      get language() {
        return state.language
      },
      getValue: () => state.text,
      setValue: () => {},
      getLineCount: () => 1,
      getLineContent: () => state.text,
      isDisposed: () => false,
      getVersionId: () => state.version,
    }),
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getSelection: () => null,
    getSelections: () => [
      { anchor: { lineNumber: 1, column: 1 }, active: { lineNumber: 1, column: 4 } },
    ],
    applyEdits: () => {},
    setDecorations: () => {},
  }
  return { editor, state }
}

function harness(hosts = ["ext.a"]) {
  const sent: Array<[string, string, unknown]> = []
  const editors = new Map<string, MonacoEditor>()
  let change: (event: MonacoEditorChangeEvent) => void = () => {}
  let active: (editor: MonacoEditor | null) => void = () => {}
  let activeId: string | null = null
  const deps: DocumentSyncDependencies = {
    send: jest.fn(async (pluginId: string, method: string, payload: unknown) => {
      sent.push([pluginId, method, payload])
    }),
    hosts: () => hosts,
    getEditor: (id) => editors.get(id),
    getActiveEditorId: () => activeId,
    onEditorChange: (listener) => {
      change = listener
      return () => {}
    },
    onActiveEditorChanged: (listener) => {
      active = listener
      return () => {}
    },
  }
  const sync = createDocumentSync(deps)
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    sync,
    sent,
    deps,
    flush,
    mount(id: string, uri: string) {
      const made = makeEditor(id, uri)
      editors.set(id, made.editor)
      change({ editorId: id, uri, kind: "open" })
      return made
    },
    fire: (event: MonacoEditorChangeEvent) => change(event),
    unmount(id: string, uri: string) {
      editors.delete(id)
      change({ editorId: id, uri, kind: "close" })
    },
    focus(id: string | null) {
      activeId = id
      active(id ? editors.get(id)! : null)
    },
  }
}

const methods = (sent: Array<[string, string, unknown]>) => sent.map(([, method]) => method)

describe("document sync", () => {
  it("reports open, edit, editors and close to every host, in order", async () => {
    const h = harness(["ext.a", "ext.b"])
    const { state } = h.mount("e1", "file:///a.ts")
    h.focus("e1")
    state.text = "two"
    state.version = 2
    h.fire({ editorId: "e1", uri: "file:///a.ts", kind: "change-content" })
    h.unmount("e1", "file:///a.ts")
    await h.flush()

    const forA = h.sent.filter(([id]) => id === "ext.a")
    // The focus report replaced the open's editors report while it waited.
    expect(methods(forA)).toEqual([
      "workspace:documentOpened",
      "window:editorsChanged",
      "workspace:documentChanged",
      "workspace:documentClosed",
      "window:editorsChanged",
    ])
    expect(forA[0][2]).toEqual({
      uri: "file:///a.ts",
      languageId: "typescript",
      version: 1,
      text: "one",
    })
    expect(forA[1][2]).toEqual({
      activeId: "e1",
      editors: [
        {
          id: "e1",
          uri: "file:///a.ts",
          selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 3 } }],
        },
      ],
    })
    expect(forA[2][2]).toEqual({ uri: "file:///a.ts", version: 2, text: "two" })
    expect(h.sent.filter(([id]) => id === "ext.b")).toHaveLength(forA.length)
  })

  it("reports what the editor shows and its indentation, when the editor knows them", async () => {
    const h = harness()
    const { editor } = h.mount("e1", "file:///a.ts")
    editor.getVisibleRanges = () => [
      { startLineNumber: 3, startColumn: 1, endLineNumber: 40, endColumn: 7 },
    ]
    editor.getOptions = () => ({ tabSize: 2, insertSpaces: false })
    h.focus("e1")
    await h.flush()
    expect(h.sent.at(-1)?.[2]).toEqual({
      activeId: "e1",
      editors: [
        {
          id: "e1",
          uri: "file:///a.ts",
          selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 3 } }],
          visibleRanges: [{ start: { line: 2, character: 0 }, end: { line: 39, character: 6 } }],
          options: { tabSize: 2, insertSpaces: false },
        },
      ],
    })
  })

  it("sends only the latest of the editors reports waiting behind a slow host", async () => {
    const h = harness()
    let release: () => void = () => {}
    const sendNow = h.deps.send as jest.Mock
    const delivered: Array<[string, unknown]> = []
    sendNow.mockImplementation(async (_pluginId: string, method: string, payload: unknown) => {
      if (method === "workspace:documentOpened") await new Promise<void>((r) => (release = r))
      delivered.push([method, payload])
    })
    const { editor } = h.mount("e1", "file:///a.ts")
    await h.flush()
    for (const column of [2, 3, 4]) {
      editor.getSelections = () => [
        { anchor: { lineNumber: 1, column: 1 }, active: { lineNumber: 1, column } },
      ]
      h.fire({ editorId: "e1", uri: "file:///a.ts", kind: "change-selection" })
    }
    release()
    await h.flush()
    await h.flush()
    expect(delivered.map(([method]) => method)).toEqual([
      "workspace:documentOpened",
      "window:editorsChanged",
    ])
    expect(delivered[1][1]).toMatchObject({
      editors: [{ selections: [{ active: { line: 0, character: 3 } }] }],
    })
    // Once that report is on its way, the next one queues behind it again.
    h.fire({ editorId: "e1", uri: "file:///a.ts", kind: "change-selection" })
    await h.flush()
    expect(delivered).toHaveLength(3)
  })

  it("closes a document only when its last editor goes", async () => {
    const h = harness()
    h.mount("e1", "file:///a.ts")
    h.mount("e2", "file:///a.ts")
    h.unmount("e1", "file:///a.ts")
    await h.flush()
    expect(methods(h.sent).filter((m) => m.startsWith("workspace:"))).toEqual([
      "workspace:documentOpened",
    ])
    h.unmount("e2", "file:///a.ts")
    await h.flush()
    expect(methods(h.sent)).toContain("workspace:documentClosed")
    expect(h.sync.openDocuments()).toEqual([])
  })

  it("reports a language switch, and skips content events that changed nothing", async () => {
    const h = harness()
    const { state } = h.mount("e1", "file:///a.ts")
    h.fire({ editorId: "e1", uri: "file:///a.ts", kind: "change-content" })
    state.language = "javascript"
    h.fire({ editorId: "e1", uri: "file:///a.ts", kind: "change-language" })
    await h.flush()
    expect(methods(h.sent)).toEqual([
      "workspace:documentOpened",
      "window:editorsChanged",
      "workspace:documentLanguageChanged",
    ])
  })

  it("brings a host that starts later up to date", async () => {
    const h = harness([])
    h.mount("e1", "file:///a.ts")
    await h.flush()
    expect(h.sent).toEqual([])
    await h.sync.replay("ext.late")
    expect(h.sent.map(([id, method]) => `${id} ${method}`)).toEqual([
      "ext.late workspace:documentOpened",
      "ext.late window:editorsChanged",
    ])
  })

  it("keeps going for other reports when a host refuses one", async () => {
    const h = harness()
    ;(h.deps.send as jest.Mock).mockRejectedValueOnce(new Error("host gone"))
    h.mount("e1", "file:///a.ts")
    await h.flush()
    expect(methods(h.sent)).toEqual(["window:editorsChanged"])
  })
})

describe("detached documents", () => {
  it("go only to the host that opened them, and follow its edits", async () => {
    const h = harness(["ext.a", "ext.b"])
    await expect(h.sync.openDetached("ext.a", "file:///d.ts", "typescript", "one")).resolves.toBe(1)
    await expect(h.sync.changeDetached("ext.a", "file:///d.ts", "two")).resolves.toBe(2)
    await expect(h.sync.changeDetached("ext.a", "file:///d.ts", "two")).resolves.toBe(2)
    await expect(h.sync.changeDetached("ext.b", "file:///d.ts", "x")).resolves.toBeUndefined()
    expect(h.sent).toEqual([
      [
        "ext.a",
        "workspace:documentOpened",
        { uri: "file:///d.ts", languageId: "typescript", version: 1, text: "one" },
      ],
      ["ext.a", "workspace:documentChanged", { uri: "file:///d.ts", version: 2, text: "two" }],
    ])
    expect(h.sync.detachedHolders("file:///d.ts")).toEqual(["ext.a"])
    expect(h.sync.heldBy("ext.a")).toEqual(["file:///d.ts"])
    expect(h.sync.heldUris()).toEqual(["file:///d.ts"])
    // Opening it again with other text is an edit.
    await expect(h.sync.openDetached("ext.a", "file:///d.ts", "typescript", "three")).resolves.toBe(
      3
    )

    h.sync.saved("file:///d.ts")
    h.sync.closeDetached("ext.a", "file:///d.ts")
    await h.flush()
    expect(methods(h.sent).slice(-2)).toEqual([
      "workspace:documentSaved",
      "workspace:documentClosed",
    ])
    expect(h.sync.detached("ext.a", "file:///d.ts")).toBeUndefined()
  })

  it("are adopted when an editor opens the same document", async () => {
    const h = harness()
    await h.sync.openDetached("ext.a", "file:///a.ts", "typescript", "disk")
    h.mount("e1", "file:///a.ts")
    await h.flush()
    expect(h.sync.detached("ext.a", "file:///a.ts")).toBeUndefined()
    expect(h.sync.editorDocument("file:///a.ts")).toEqual({
      languageId: "typescript",
      version: 1,
      text: "one",
    })
    // Already shown: opening it detached answers the editor's version.
    await expect(h.sync.openDetached("ext.a", "file:///a.ts", "typescript", "x")).resolves.toBe(1)
    expect(methods(h.sent)).toEqual([
      "workspace:documentOpened",
      "workspace:documentOpened",
      "window:editorsChanged",
    ])
  })

  it("keep a bounded number per host, closing the oldest", async () => {
    const h = harness()
    for (let index = 0; index <= MAX_DETACHED_DOCUMENTS; index += 1) {
      await h.sync.openDetached("ext.a", `untitled:${index}`, "plaintext", "")
    }
    expect(h.sync.heldBy("ext.a")).toHaveLength(MAX_DETACHED_DOCUMENTS)
    expect(h.sync.detached("ext.a", "untitled:0")).toBeUndefined()
    expect(h.sent.at(-1)).toEqual(["ext.a", "workspace:documentClosed", { uri: "untitled:0" }])
  })

  it("are gone when the host restarts or stops", async () => {
    const h = harness()
    await h.sync.openDetached("ext.a", "untitled:1", "plaintext", "")
    await h.sync.replay("ext.a")
    expect(h.sync.heldBy("ext.a")).toEqual([])
    await h.sync.openDetached("ext.a", "untitled:1", "plaintext", "")
    h.sync.forget("ext.a")
    expect(h.sync.heldBy("ext.a")).toEqual([])
  })
})
