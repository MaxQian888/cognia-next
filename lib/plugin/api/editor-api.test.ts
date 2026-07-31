const requestReveal = jest.fn()
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ requestReveal }) },
}))

import {
  __resetProjectEditorBridgeForTesting,
  notifyActiveEditorChanged,
  registerProjectEditorOpener,
  type ActiveEditorContext,
} from "@/lib/files/project-editor-bridge"
import { __setEditorPiiGateForTesting, createEditorAPI } from "./editor-api"

const ALL = () => true
const NONE = () => false

const snapshot = (over: Partial<ActiveEditorContext> = {}): ActiveEditorContext => ({
  path: "/repo/src/a.ts",
  selection: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 },
  selectedText: "const",
  diagnostics: [{ message: "boom", severity: "error", line: 3, column: 5 }],
  openEditors: ["/repo/src/a.ts"],
  ...over,
})

beforeEach(() => {
  __resetProjectEditorBridgeForTesting()
  __setEditorPiiGateForTesting(ALL)
  requestReveal.mockClear()
})

afterAll(() => __setEditorPiiGateForTesting(null))

describe("openFile", () => {
  it("opens immediately when an editor is mounted", async () => {
    const open = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open })

    await expect(createEditorAPI("p", ALL).openFile("/repo/src/a.ts", { line: 8 })).resolves.toBe(
      "opened"
    )
    expect(open).toHaveBeenCalledWith("src/a.ts", 8, undefined)
    expect(requestReveal).not.toHaveBeenCalled()
  })

  it("queues the open without stealing the rail when nothing is mounted", async () => {
    // The default has to be quiet: a plugin that can silently take over the
    // right rail displaces whatever the user was actually looking at.
    await expect(createEditorAPI("p", ALL).openFile("/repo/src/a.ts")).resolves.toBe("deferred")
    expect(requestReveal).not.toHaveBeenCalled()
  })

  it("replays a deferred open once an editor mounts", async () => {
    await createEditorAPI("p", ALL).openFile("/repo/src/a.ts", { line: 4, column: 2 })

    const open = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open })

    expect(open).toHaveBeenCalledWith("src/a.ts", 4, 2)
  })

  it("summons the workspace panel only when the plugin opts in", async () => {
    await expect(
      createEditorAPI("p", ALL).openFile("/repo/src/a.ts", { reveal: true })
    ).resolves.toBe("revealing")
    expect(requestReveal).toHaveBeenCalledWith({ panelId: "workspace", mode: "wide" })
  })

  it("still queues the open when revealing, so the file lands on mount", async () => {
    await createEditorAPI("p", ALL).openFile("/repo/src/a.ts", { line: 9, reveal: true })

    const open = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open })

    expect(open).toHaveBeenCalledWith("src/a.ts", 9, undefined)
  })

  it("refuses without editor:write", async () => {
    await expect(createEditorAPI("p", NONE).openFile("/repo/src/a.ts")).rejects.toThrow(
      /editor:write/
    )
  })
})

describe("reflectEdit", () => {
  it("routes to the editor's applyEdit when it has one", async () => {
    const applyEdit = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open: jest.fn(), applyEdit })

    await expect(
      createEditorAPI("p", ALL).reflectEdit("/repo/src/a.ts", { line: 3 })
    ).resolves.toBe(true)
    expect(applyEdit).toHaveBeenCalledWith("src/a.ts", 3, undefined)
  })

  it("reports false rather than queueing when nothing is mounted", async () => {
    // Unlike openFile: a reflect that lands minutes later would reflect content
    // that has since changed on disk.
    await expect(createEditorAPI("p", ALL).reflectEdit("/repo/src/a.ts")).resolves.toBe(false)

    const open = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open })
    expect(open).not.toHaveBeenCalled()
  })

  it("refuses without editor:write", async () => {
    await expect(createEditorAPI("p", NONE).reflectEdit("/repo/a.ts")).rejects.toThrow(
      /editor:write/
    )
  })
})

describe("readActive", () => {
  it("returns the snapshot without needing the plugin to know a project root", async () => {
    registerProjectEditorOpener({
      root: "/repo",
      open: jest.fn(),
      readActive: async () => snapshot(),
    })

    await expect(createEditorAPI("p", ALL).readActive()).resolves.toEqual(snapshot())
  })

  it("returns null when no editor is mounted", async () => {
    await expect(createEditorAPI("p", ALL).readActive()).resolves.toBeNull()
  })

  it("returns null instead of rejecting when the engine's transport fails", async () => {
    registerProjectEditorOpener({
      root: "/repo",
      open: jest.fn(),
      readActive: async () => {
        throw new Error("companion extension not connected")
      },
    })

    await expect(createEditorAPI("p", ALL).readActive()).resolves.toBeNull()
  })

  it("withholds text-bearing fields when the PII gate trips", async () => {
    __setEditorPiiGateForTesting(NONE)
    registerProjectEditorOpener({
      root: "/repo",
      open: jest.fn(),
      readActive: async () => snapshot(),
    })

    const result = await createEditorAPI("p", ALL).readActive()

    expect(result).toEqual({
      path: null,
      selection: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 },
      selectedText: null,
      diagnostics: [],
      openEditors: [],
      redacted: true,
    })
  })

  it("refuses without editor:read", async () => {
    await expect(createEditorAPI("p", NONE).readActive()).rejects.toThrow(/editor:read/)
  })

  it("does not accept editor:write as a substitute for editor:read", async () => {
    const writeOnly = (permission: string) => permission === "editor:write"

    await expect(createEditorAPI("p", writeOnly).readActive()).rejects.toThrow(/editor:read/)
  })
})

describe("onDidChangeActiveEditor", () => {
  it("fires when an editor mounts and when it unmounts", () => {
    const listener = jest.fn()
    createEditorAPI("p", ALL).onDidChangeActiveEditor(listener)

    const unregister = registerProjectEditorOpener({ root: "/repo", open: jest.fn() })
    expect(listener).toHaveBeenCalledTimes(1)

    unregister()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("fires when a mounted editor reports the user moved", () => {
    const listener = jest.fn()
    createEditorAPI("p", ALL).onDidChangeActiveEditor(listener)

    notifyActiveEditorChanged()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("stops firing after dispose", () => {
    const listener = jest.fn()
    const dispose = createEditorAPI("p", ALL).onDidChangeActiveEditor(listener)

    dispose()
    notifyActiveEditorChanged()

    expect(listener).not.toHaveBeenCalled()
  })

  it("never fires without editor:read, rather than firing empty", () => {
    // Otherwise the event itself becomes an oracle for editor activity the
    // plugin is not allowed to observe.
    const listener = jest.fn()
    createEditorAPI("p", NONE).onDidChangeActiveEditor(listener)

    notifyActiveEditorChanged()

    expect(listener).not.toHaveBeenCalled()
  })

  it("re-checks the grant on every fire, so a revoke takes effect at once", () => {
    let granted = true
    const listener = jest.fn()
    createEditorAPI("p", () => granted).onDidChangeActiveEditor(listener)

    notifyActiveEditorChanged()
    expect(listener).toHaveBeenCalledTimes(1)

    granted = false
    notifyActiveEditorChanged()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("saveDirty", () => {
  it("flushes so a plugin's next disk read is not stale", async () => {
    // The plugin filesystem API reads disk, so an unsaved buffer is invisible to
    // it and a later write would clobber the user's work.
    const saveDirty = jest.fn().mockResolvedValue([])
    registerProjectEditorOpener({ root: "/repo", open: jest.fn(), saveDirty })

    await expect(createEditorAPI("p", ALL).saveDirty()).resolves.toEqual([])
    expect(saveDirty).toHaveBeenCalled()
  })

  it("reports the files it could not save", async () => {
    registerProjectEditorOpener({
      root: "/repo",
      open: jest.fn(),
      saveDirty: jest.fn().mockResolvedValue(["/repo/a.ts"]),
    })

    await expect(createEditorAPI("p", ALL).saveDirty()).resolves.toEqual(["/repo/a.ts"])
  })

  it("refuses without editor:write", async () => {
    await expect(createEditorAPI("p", NONE).saveDirty()).rejects.toThrow("editor:write")
  })
})

describe("showDiff", () => {
  it("routes a proposal to the mounted engine's diff surface", async () => {
    const showDiff = jest.fn().mockResolvedValue(undefined)
    registerProjectEditorOpener({ root: "/repo", open: jest.fn(), showDiff })

    await expect(
      createEditorAPI("p", ALL).showDiff("/repo/src/a.ts", "next", "Proposed")
    ).resolves.toBe(true)
    expect(showDiff).toHaveBeenCalledWith("src/a.ts", "next", "Proposed")
  })

  it("reports false when the mounted engine has no diff surface", async () => {
    registerProjectEditorOpener({ root: "/repo", open: jest.fn() })
    await expect(createEditorAPI("p", ALL).showDiff("/repo/a.ts", "next")).resolves.toBe(false)
  })

  it("refuses without editor:write", async () => {
    await expect(createEditorAPI("p", NONE).showDiff("/repo/a.ts", "x")).rejects.toThrow(
      "editor:write"
    )
  })
})

describe("revealInExplorer", () => {
  it("reveals through the mounted engine's file tree", async () => {
    const reveal = jest.fn().mockResolvedValue(undefined)
    registerProjectEditorOpener({ root: "/repo", open: jest.fn(), reveal })

    await expect(createEditorAPI("p", ALL).revealInExplorer("/repo/src/a.ts")).resolves.toBe(true)
    expect(reveal).toHaveBeenCalledWith("src/a.ts")
  })

  it("refuses without editor:write, because it moves the user's view", async () => {
    await expect(createEditorAPI("p", NONE).revealInExplorer("/repo/a.ts")).rejects.toThrow(
      "editor:write"
    )
  })
})

describe("runInTerminal", () => {
  it("runs in the editor's own terminal, keyed by project root", async () => {
    const runInTerminal = jest.fn().mockResolvedValue(undefined)
    registerProjectEditorOpener({ root: "/repo", open: jest.fn(), runInTerminal })

    await expect(
      createEditorAPI("p", ALL).runInTerminal("/repo", "pnpm test", { name: "Tests" })
    ).resolves.toBe(true)
    expect(runInTerminal).toHaveBeenCalledWith("pnpm test", { cwd: "/repo", name: "Tests" })
  })

  it("requires terminal:write even when editor:write remains granted", async () => {
    const editorOnly = (permission: string) => permission === "editor:write"

    await expect(createEditorAPI("p", editorOnly).runInTerminal("/repo", "ls")).rejects.toThrow(
      "terminal:write"
    )
  })

  it("re-checks terminal:write on every command", async () => {
    const runInTerminal = jest.fn().mockResolvedValue(undefined)
    registerProjectEditorOpener({ root: "/repo", open: jest.fn(), runInTerminal })
    let granted = true
    const api = createEditorAPI("p", (permission) => permission === "terminal:write" && granted)

    await expect(api.runInTerminal("/repo", "pnpm test")).resolves.toBe(true)
    granted = false
    await expect(api.runInTerminal("/repo", "pnpm build")).rejects.toThrow("terminal:write")
    expect(runInTerminal).toHaveBeenCalledTimes(1)
  })

  it("rejects a cwd that escapes the project root", async () => {
    const runInTerminal = jest.fn().mockResolvedValue(undefined)
    registerProjectEditorOpener({ root: "/repo", open: jest.fn(), runInTerminal })

    await expect(
      createEditorAPI("p", ALL).runInTerminal("/repo", "cat secrets", {
        cwd: "/repo/../private",
      })
    ).rejects.toThrow(/project root/)
    expect(runInTerminal).not.toHaveBeenCalled()
  })
})

describe("notify", () => {
  it("surfaces a message in whichever editor is mounted", async () => {
    const notify = jest.fn().mockResolvedValue(undefined)
    registerProjectEditorOpener({ root: "/repo", open: jest.fn(), notify })

    await expect(createEditorAPI("p", ALL).notify("done", "warning")).resolves.toBe(true)
    expect(notify).toHaveBeenCalledWith("done", "warning")
  })

  it("reports false rather than throwing when no editor can show one", async () => {
    await expect(createEditorAPI("p", ALL).notify("done")).resolves.toBe(false)
  })

  it("refuses without editor:write, because it puts plugin text in front of the user", async () => {
    await expect(createEditorAPI("p", NONE).notify("done")).rejects.toThrow("editor:write")
  })
})
