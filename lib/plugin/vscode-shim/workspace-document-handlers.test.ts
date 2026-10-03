type Handler = (
  payload: unknown,
  context: { pluginId: string; method: string; requestId: null }
) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockLog = jest.fn()
jest.mock("./vscode-log-buffer", () => ({
  appendVscodeLog: (...args: unknown[]) => mockLog(...args),
}))

const mockFs = {
  listWorkspaceRoots: jest.fn(async () => [{ path: "/repo", source: "desktop-project" }]),
  readWorkspaceFile: jest.fn(async () => "x"),
  writeWorkspaceFile: jest.fn(async () => undefined),
  statWorkspaceFile: jest.fn(async () => ({ exists: true, isDir: false, size: 1, mtimeMs: 1 })),
  deleteWorkspaceEntry: jest.fn(async () => undefined),
  renameWorkspaceEntry: jest.fn(async () => undefined),
}
jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceRoots: () => mockFs.listWorkspaceRoots(),
  readWorkspaceFile: (...args: unknown[]) => mockFs.readWorkspaceFile(...(args as [])),
  writeWorkspaceFile: (...args: unknown[]) => mockFs.writeWorkspaceFile(...(args as [])),
  statWorkspaceFile: (...args: unknown[]) => mockFs.statWorkspaceFile(...(args as [])),
  deleteWorkspaceEntry: (...args: unknown[]) => mockFs.deleteWorkspaceEntry(...(args as [])),
  renameWorkspaceEntry: (...args: unknown[]) => mockFs.renameWorkspaceEntry(...(args as [])),
}))
const mockPermissions = jest.fn(async (_pluginId: string): Promise<string[]> => [])
jest.mock("@/lib/plugin/core/transport", () => ({
  listPluginPermissions: (pluginId: string) => mockPermissions(pluginId),
}))

import { createDocumentSync, type DocumentSync } from "./document-sync"
import type { MonacoEditor, MonacoEditorChangeEvent } from "./monaco-bridge"
import {
  __resetVscodeDocumentsForTesting,
  clearVscodeDocumentsForPlugin,
  configureVscodeDocuments,
  createVscodeDocumentsDependencies,
  installVscodeDocumentHandlers,
  type VscodeDocumentsDependencies,
} from "./workspace-document-handlers"

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

function setup(options: { granted?: string[] } = {}) {
  const sent: Array<[string, string, Record<string, unknown>]> = []
  const editors = new Map<string, MonacoEditor>()
  let change: (event: MonacoEditorChangeEvent) => void = () => {}
  const providerAnswers = new Map<string, unknown>()
  const sendToHost = jest.fn(async (pluginId: string, method: string, payload: unknown) => {
    sent.push([pluginId, method, payload as Record<string, unknown>])
    if (method === "extension:call") {
      return providerAnswers.get((payload as { token: string }).token)
    }
    return null
  })
  const sync: DocumentSync = createDocumentSync({
    send: sendToHost,
    hosts: () => ["ext.a", "ext.b"],
    getEditor: (id) => editors.get(id),
    getActiveEditorId: () => null,
    onEditorChange: (listener) => {
      change = listener
      return () => {}
    },
    onActiveEditorChanged: () => () => {},
  })
  const files = new Map<string, string>([["/repo/a.ts", "hello\nworld"]])
  const watchers = new Map<string, (change: { kind: string; path: string }) => void>()
  const stoppedWatches: string[] = []
  const savedListeners = new Set<(path: string) => void>()
  const deps: VscodeDocumentsDependencies = {
    sync,
    sendToHost,
    permissions: async () => options.granted ?? [],
    pathOf: (uri) => (uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : null),
    uriOf: (path) => `file://${path}`,
    fs: {
      roots: async () => ["/repo"],
      read: jest.fn(async (root: string, relPath: string) => {
        const text = files.get(`${root}/${relPath}`)
        if (text === undefined) throw new Error("missing")
        return text
      }),
      write: jest.fn(async (root: string, relPath: string, text: string) => {
        files.set(`${root}/${relPath}`, text)
      }),
      stat: jest.fn(async (root: string, relPath: string) => ({
        exists: files.has(`${root}/${relPath}`) || relPath === "dir",
        isDir: relPath === "dir",
      })),
      remove: jest.fn(async (root: string, relPath: string) => {
        files.delete(`${root}/${relPath}`)
      }),
      rename: jest.fn(async (root: string, from: string, to: string) => {
        files.set(`${root}/${to}`, files.get(`${root}/${from}`) ?? "")
        files.delete(`${root}/${from}`)
      }),
      watch: jest.fn((root: string, listener: (change: { kind: string; path: string }) => void) => {
        watchers.set(root, listener)
        return () => {
          watchers.delete(root)
          stoppedWatches.push(root)
        }
      }),
    },
    editor: {
      open: jest.fn(() => true),
      save: jest.fn(async () => true as boolean | null),
      saveAll: jest.fn(async () => [] as string[]),
      onSaved: (listener) => {
        savedListeners.add(listener)
        return () => savedListeners.delete(listener)
      },
    },
    applyDocumentEdits: jest.fn(() => null),
    languageOf: (path) => (path.endsWith(".ts") ? "typescript" : "plaintext"),
  }
  configureVscodeDocuments(deps)

  /** Show `uri` in a Monaco editor, as the bridge reports it. */
  const showInEditor = (uri: string, text: string, version = 1) => {
    editors.set("e1", {
      id: "e1",
      getModel: () => ({
        uri,
        language: "typescript",
        getValue: () => text,
        setValue: () => {},
        getLineCount: () => 1,
        getLineContent: () => text,
        isDisposed: () => false,
        getVersionId: () => version,
      }),
      getPosition: () => null,
      getSelection: () => null,
      applyEdits: () => {},
      setDecorations: () => {},
    })
    change({ editorId: "e1", uri, kind: "open" })
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const call = (method: string, payload: unknown, pluginId = "ext.a") =>
    handlers.get(method)!(payload, { pluginId, method, requestId: null })
  const methodsFor = (pluginId: string) =>
    sent.filter(([id]) => id === pluginId).map(([, method]) => method)
  return {
    deps,
    sync,
    sent,
    files,
    providerAnswers,
    showInEditor,
    flush,
    call,
    methodsFor,
    fireSaved: (path: string) => savedListeners.forEach((listener) => listener(path)),
    watchers,
    stoppedWatches,
  }
}

beforeEach(() => {
  handlers.clear()
  mockLog.mockClear()
  __resetVscodeDocumentsForTesting()
  installVscodeDocumentHandlers()
})

describe("workspace.openTextDocument", () => {
  it("answers with the editor's document when one shows it, reading nothing", async () => {
    const h = setup()
    h.showInEditor("file:///repo/a.ts", "live", 7)
    await expect(
      h.call("workspace:openTextDocument", { uri: "file:///repo/a.ts" })
    ).resolves.toEqual({ uri: "file:///repo/a.ts", version: 7 })
    expect(h.deps.fs.read).not.toHaveBeenCalled()
  })

  it("reads a file into a document only the asking host sees, with filesystem:read", async () => {
    const h = setup({ granted: ["filesystem:read"] })
    await expect(
      h.call("workspace:openTextDocument", { extensionId: "ext.a", uri: "file:///repo/a.ts" })
    ).resolves.toEqual({ uri: "file:///repo/a.ts", version: 1 })
    expect(h.sent).toContainEqual([
      "ext.a",
      "workspace:documentOpened",
      { uri: "file:///repo/a.ts", languageId: "typescript", version: 1, text: "hello\nworld" },
    ])
    expect(h.methodsFor("ext.b")).toEqual([])
    // Asking again reuses it.
    await h.call("workspace:openTextDocument", { uri: "file:///repo/a.ts" })
    expect(h.deps.fs.read).toHaveBeenCalledTimes(1)
  })

  it("refuses without permission, outside the workspace, and for missing files", async () => {
    await expect(
      setup().call("workspace:openTextDocument", { uri: "file:///repo/a.ts" })
    ).rejects.toThrow(/requires permission filesystem:read/)
    const h = setup({ granted: ["filesystem:read"] })
    await expect(
      h.call("workspace:openTextDocument", { uri: "file:///etc/passwd" })
    ).rejects.toThrow(/not a file in the open workspace/)
    await expect(
      h.call("workspace:openTextDocument", { uri: "file:///repo/nope.ts" })
    ).rejects.toThrow(/does not exist/)
    await expect(h.call("workspace:openTextDocument", { uri: "file:///repo/dir" })).rejects.toThrow(
      /directory/
    )
    await expect(
      h.call("workspace:openTextDocument", { extensionId: "ext.b", uri: "file:///repo/a.ts" })
    ).rejects.toThrow(/ownership/)
  })

  it("numbers untitled documents per extension and starts them with the given text", async () => {
    const h = setup()
    await expect(
      h.call("workspace:openTextDocument", { untitled: { content: "draft", language: "markdown" } })
    ).resolves.toEqual({ uri: "untitled:Untitled-1", version: 1 })
    await expect(h.call("workspace:openTextDocument", { untitled: {} })).resolves.toEqual({
      uri: "untitled:Untitled-2",
      version: 1,
    })
    expect(h.sync.detached("ext.a", "untitled:Untitled-1")).toEqual({
      languageId: "markdown",
      version: 1,
      text: "draft",
    })
  })

  it("asks the content provider registered for a scheme, across extensions", async () => {
    const h = setup()
    h.call(
      "workspace:registerTextDocumentContentProvider",
      { extensionId: "ext.b", scheme: "git", token: "tdcp:b" },
      "ext.b"
    )
    h.providerAnswers.set("tdcp:b", "old text")
    await expect(h.call("workspace:openTextDocument", { uri: "git:/a.ts?HEAD" })).resolves.toEqual({
      uri: "git:/a.ts?HEAD",
      version: 1,
    })
    expect(h.sent).toContainEqual([
      "ext.b",
      "extension:call",
      { token: "tdcp:b", method: "provideTextDocumentContent", payload: { uri: "git:/a.ts?HEAD" } },
    ])
    expect(h.sync.detached("ext.a", "git:/a.ts?HEAD")?.text).toBe("old text")

    // The provider says the content changed: every host holding it gets the new text.
    h.providerAnswers.set("tdcp:b", "new text")
    await h.call(
      "workspace:textDocumentContentChanged",
      { scheme: "git", uri: "git:/a.ts?HEAD" },
      "ext.b"
    )
    expect(h.sync.detached("ext.a", "git:/a.ts?HEAD")).toMatchObject({
      text: "new text",
      version: 2,
    })
    await expect(
      h.call("workspace:textDocumentContentChanged", { scheme: "git", uri: "git:/x" }, "ext.a")
    ).rejects.toThrow(/no content provider/)

    h.call(
      "workspace:unregisterTextDocumentContentProvider",
      { scheme: "git", token: "tdcp:b" },
      "ext.b"
    )
    await expect(h.call("workspace:openTextDocument", { uri: "git:/b.ts" })).rejects.toThrow(
      /No text document content provider/
    )
  })

  it("keeps file and untitled schemes away from content providers", () => {
    setup()
    expect(() =>
      handlers.get("workspace:registerTextDocumentContentProvider")!(
        { scheme: "file", token: "t" },
        { pluginId: "ext.a", method: "m", requestId: null }
      )
    ).toThrow(/cannot have a content provider/)
  })

  it("drops a stopped extension's providers", async () => {
    const h = setup()
    h.call("workspace:registerTextDocumentContentProvider", { scheme: "git", token: "t" }, "ext.b")
    clearVscodeDocumentsForPlugin("ext.b")
    await expect(h.call("workspace:openTextDocument", { uri: "git:/a" })).rejects.toThrow(
      /No text document content provider/
    )
  })
})

describe("files held outside an editor", () => {
  it("follow the disk while a host holds them, and stop being watched after", async () => {
    const h = setup({ granted: ["filesystem:read"] })
    await h.call("workspace:openTextDocument", { uri: "file:///repo/a.ts" })
    expect([...h.watchers.keys()]).toEqual(["/repo"])

    h.files.set("/repo/a.ts", "changed on disk")
    h.watchers.get("/repo")!({ kind: "modify", path: "/repo/a.ts" })
    await h.flush()
    expect(h.sync.detached("ext.a", "file:///repo/a.ts")).toMatchObject({
      text: "changed on disk",
      version: 2,
    })
    // A delete keeps the last text.
    h.watchers.get("/repo")!({ kind: "delete", path: "/repo/a.ts" })
    await h.flush()
    expect(h.sync.detached("ext.a", "file:///repo/a.ts")?.text).toBe("changed on disk")

    h.sync.closeDetached("ext.a", "file:///repo/a.ts")
    h.watchers.get("/repo")!({ kind: "modify", path: "/repo/b.ts" })
    await h.flush()
    expect(h.stoppedWatches).toEqual(["/repo"])
  })
})

describe("workspace.applyEdit", () => {
  it("edits a document an editor shows through Monaco, without file permissions", async () => {
    const h = setup()
    h.showInEditor("file:///repo/a.ts", "hello", 3)
    ;(h.deps.applyDocumentEdits as jest.Mock).mockReturnValue({ applied: true, version: 4 })
    const edits = [{ range: range(0, 0, 0, 0), newText: ">" }]
    await expect(
      h.call("workspace:applyEdit", {
        edit: { operations: [{ kind: "edit", uri: "file:///repo/a.ts", edits, eol: 2 }] },
      })
    ).resolves.toEqual({ applied: true, versions: { "file:///repo/a.ts": 4 } })
    expect(h.deps.applyDocumentEdits).toHaveBeenCalledWith({
      uri: "file:///repo/a.ts",
      edits,
      eol: 2,
    })
    expect(h.deps.fs.write).not.toHaveBeenCalled()
  })

  it("needs filesystem:write to change files on disk", async () => {
    const h = setup({ granted: ["filesystem:read"] })
    await expect(
      h.call("workspace:applyEdit", {
        edit: { operations: [{ kind: "delete", uri: "file:///repo/a.ts" }] },
      })
    ).rejects.toThrow(/filesystem:write/)
    expect(h.files.has("/repo/a.ts")).toBe(true)
  })

  it("applies file operations and edits in order, updating held copies", async () => {
    const h = setup({ granted: ["filesystem:read", "filesystem:write"] })
    await h.call("workspace:openTextDocument", { uri: "file:///repo/a.ts" })
    const result = await h.call("workspace:applyEdit", {
      edit: {
        operations: [
          { kind: "create", uri: "file:///repo/new.ts", contents: { text: "made" } },
          {
            kind: "edit",
            uri: "file:///repo/new.ts",
            edits: [{ range: range(0, 4, 0, 4), newText: "!" }],
          },
          {
            kind: "edit",
            uri: "file:///repo/a.ts",
            edits: [{ range: range(1, 0, 1, 5), newText: "there" }],
          },
          { kind: "rename", oldUri: "file:///repo/new.ts", newUri: "file:///repo/moved.ts" },
          { kind: "create", uri: "file:///repo/a.ts", options: { ignoreIfExists: true } },
          { kind: "delete", uri: "file:///repo/gone.ts", options: { ignoreIfNotExists: true } },
        ],
      },
    })
    expect(result).toEqual({ applied: true, versions: { "file:///repo/a.ts": 2 } })
    expect(h.files.get("/repo/moved.ts")).toBe("made!")
    expect(h.files.has("/repo/new.ts")).toBe(false)
    expect(h.files.get("/repo/a.ts")).toBe("hello\nthere")
    expect(h.sync.detached("ext.a", "file:///repo/a.ts")?.text).toBe("hello\nthere")
  })

  it("edits a held untitled document in place", async () => {
    const h = setup()
    await h.call("workspace:openTextDocument", { untitled: { content: "abc" } })
    await expect(
      h.call("workspace:applyEdit", {
        edit: {
          operations: [
            {
              kind: "edit",
              uri: "untitled:Untitled-1",
              edits: [{ range: range(0, 3, 0, 3), newText: "d" }],
            },
          ],
        },
      })
    ).resolves.toEqual({ applied: true, versions: { "untitled:Untitled-1": 2 } })
  })

  it("stops at the first failing step, answers false and says why in the log", async () => {
    const h = setup({ granted: ["filesystem:read", "filesystem:write"] })
    const result = await h.call("workspace:applyEdit", {
      edit: {
        operations: [
          { kind: "create", uri: "file:///repo/b.ts" },
          { kind: "create", uri: "file:///repo/a.ts" },
          { kind: "delete", uri: "file:///repo/b.ts" },
        ],
      },
    })
    expect(result).toEqual({ applied: false, versions: {} })
    expect(h.files.has("/repo/b.ts")).toBe(true)
    expect(mockLog).toHaveBeenCalledWith(
      "ext.a",
      expect.objectContaining({ level: "warn", message: expect.stringMatching(/already exists/) })
    )
  })

  it("refuses binary contents and moves across workspace folders", async () => {
    const h = setup({ granted: ["filesystem:read", "filesystem:write"] })
    for (const operation of [
      { kind: "create", uri: "file:///repo/bin", contents: { binary: true } },
      { kind: "create", uri: "file:///repo/a.ts" },
    ]) {
      await expect(
        h.call("workspace:applyEdit", { edit: { operations: [operation] } })
      ).resolves.toMatchObject({ applied: false })
    }
    await expect(h.call("workspace:applyEdit", { edit: {} })).rejects.toThrow(/operations/)
    await expect(
      h.call("workspace:applyEdit", {
        edit: { operations: [{ kind: "chmod", uri: "file:///repo/a" }] },
      })
    ).rejects.toThrow(/Unknown workspace edit step/)
  })
})

describe("saving", () => {
  it("saves a shown file through the project editor", async () => {
    const h = setup()
    h.showInEditor("file:///repo/a.ts", "text")
    await expect(h.call("workspace:saveTextDocument", { uri: "file:///repo/a.ts" })).resolves.toBe(
      true
    )
    expect(h.deps.editor.save).toHaveBeenCalledWith("/repo/a.ts")
  })

  it("writes the editor's text itself when no project editor owns the file", async () => {
    const h = setup({ granted: ["filesystem:write"] })
    h.showInEditor("file:///repo/a.ts", "unsaved")
    ;(h.deps.editor.save as jest.Mock).mockResolvedValueOnce(null)
    await expect(h.call("workspace:saveTextDocument", { uri: "file:///repo/a.ts" })).resolves.toBe(
      true
    )
    expect(h.files.get("/repo/a.ts")).toBe("unsaved")
    await h.flush()
    expect(h.methodsFor("ext.b")).toContain("workspace:documentSaved")
  })

  it("cannot save untitled documents, and says so", async () => {
    const h = setup()
    await h.call("workspace:openTextDocument", { untitled: {} })
    await expect(
      h.call("workspace:saveTextDocument", { uri: "untitled:Untitled-1" })
    ).resolves.toBe(false)
    expect(mockLog).toHaveBeenCalledWith(
      "ext.a",
      expect.objectContaining({ message: expect.stringMatching(/not supported/) })
    )
    await expect(h.call("workspace:saveAll", { includeUntitled: true })).resolves.toBe(false)
    await expect(h.call("workspace:saveAll", {})).resolves.toBe(true)
  })

  it("reports saveAll failures", async () => {
    const h = setup()
    ;(h.deps.editor.saveAll as jest.Mock).mockResolvedValueOnce(["/repo/a.ts"])
    await expect(h.call("workspace:saveAll", {})).resolves.toBe(false)
  })

  it("tells the hosts when the user saves a file they see", async () => {
    const h = setup()
    h.showInEditor("file:///repo/a.ts", "text")
    h.fireSaved("/repo/a.ts")
    await h.flush()
    expect(h.methodsFor("ext.a")).toContain("workspace:documentSaved")
    expect(h.methodsFor("ext.b")).toContain("workspace:documentSaved")
  })
})

describe("window.showTextDocument", () => {
  it("opens the file in the project editor at the selection's start", () => {
    const h = setup()
    expect(
      h.call("window:showTextDocument", { uri: "file:///repo/a.ts", selection: range(4, 2, 4, 6) })
    ).toEqual({ uri: "file:///repo/a.ts" })
    expect(h.deps.editor.open).toHaveBeenCalledWith("/repo/a.ts", 5, 3)
  })

  it("explains when it cannot show the document", () => {
    const h = setup()
    expect(() => h.call("window:showTextDocument", { uri: "untitled:Untitled-1" })).toThrow(
      /Only files/
    )
    ;(h.deps.editor.open as jest.Mock).mockReturnValueOnce(false)
    expect(() => h.call("window:showTextDocument", { uri: "file:///repo/a.ts" })).toThrow(
      /No project editor is open/
    )
  })
})

describe("createVscodeDocumentsDependencies", () => {
  it("reads the workspace and permissions through the app's own services", async () => {
    const sync = {} as DocumentSync
    const deps = createVscodeDocumentsDependencies(sync, jest.fn())
    expect(deps.sync).toBe(sync)
    await expect(deps.fs.roots()).resolves.toEqual(["/repo"])
    expect(typeof deps.fs.watch).toBe("function")
    await expect(deps.fs.stat("/repo", "a.ts")).resolves.toEqual({ exists: true, isDir: false })
    await deps.fs.write("/repo", "a.ts", "t")
    expect(mockFs.writeWorkspaceFile).toHaveBeenCalledWith("/repo", "a.ts", "t")
    mockPermissions.mockResolvedValueOnce(["filesystem:read"])
    await expect(deps.permissions("ext.a")).resolves.toEqual(["filesystem:read"])
    expect(deps.pathOf("file:///repo/a%20b.ts")).toBe("/repo/a b.ts")
    expect(deps.uriOf("/repo/a b.ts")).toBe("file:///repo/a%20b.ts")
    expect(deps.languageOf("/repo/a.ts")).toBe("typescript")
  })
})
