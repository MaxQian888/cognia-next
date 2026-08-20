/**
 * @jest-environment jsdom
 *
 * jsdom because these run against the REAL `pane-manager` binding rather than a
 * stub of the resolver — the addressing rule is only worth testing against the
 * thing that actually does the binding — and the manager publishes a marker on
 * `document.documentElement`.
 */
import type { StepExecutionContext } from "@/types/workflow/visual"

const ensure = jest.fn().mockResolvedValue({ running: true, port: 43117 })
const driveOpen = jest.fn().mockResolvedValue(undefined)
const openFile = jest.fn().mockResolvedValue(undefined)
const driveApplyEdit = jest.fn().mockResolvedValue(undefined)
const reveal = jest.fn().mockResolvedValue(undefined)
const showDiff = jest.fn().mockResolvedValue(undefined)
const saveAll = jest.fn().mockResolvedValue({ saved: ["/repo/a.ts"], failed: [] })
const readActive = jest.fn()

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    ensure: (...a: unknown[]) => ensure(...a),
    driveOpen: (...a: unknown[]) => driveOpen(...a),
    openFile: (...a: unknown[]) => openFile(...a),
    driveApplyEdit: (...a: unknown[]) => driveApplyEdit(...a),
    reveal: (...a: unknown[]) => reveal(...a),
    showDiff: (...a: unknown[]) => showDiff(...a),
    saveAll: (...a: unknown[]) => saveAll(...a),
    readActive: (...a: unknown[]) => readActive(...a),
    // Consumed by pane-manager when a claim reaches the native layer.
    embedCreate: jest.fn().mockResolvedValue("codeserver-embed"),
    embedSetBounds: jest.fn().mockResolvedValue(undefined),
    embedSetVisible: jest.fn().mockResolvedValue(undefined),
    embedNavigate: jest.fn().mockResolvedValue(undefined),
    embedSetBackground: jest.fn().mockResolvedValue(undefined),
    embedDestroy: jest.fn().mockResolvedValue(undefined),
  },
}))

import "."
import {
  __resetCodeServerPaneManagerForTesting,
  claimCodeServerPane,
} from "@/lib/codeserver/pane-manager"
import { getExecutor } from "../registry"

const BOUND = "/Users/dev/bound-project"

function run(kind: string, params: Record<string, unknown>) {
  const reg = getExecutor(kind as never, 1)
  if (!reg) throw new Error(`no executor for ${kind}`)
  return reg.execute({ params } as unknown as StepExecutionContext)
}

/** Put a Pro IDE on the pane so the addressing fallback has something to find. */
const bind = (root = BOUND) =>
  claimCodeServerPane({
    ownerId: "editor",
    root,
    url: "http://127.0.0.1:43117/",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    onRevoked: jest.fn(),
  })

const CLEAN_ACTIVE = {
  path: "/Users/dev/bound-project/src/index.ts",
  selection: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 9 },
  selectedText: "const x = 1",
  diagnostics: [],
  openEditors: ["/Users/dev/bound-project/src/index.ts"],
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetCodeServerPaneManagerForTesting()
  saveAll.mockResolvedValue({ saved: ["/repo/a.ts"], failed: [] })
  readActive.mockResolvedValue(CLEAN_ACTIVE)
})

describe("addressing", () => {
  it("prefers an explicit root over the bound one", async () => {
    await bind()
    await run("action.editor.reveal", { root: "/other/project", path: "a.ts" })
    expect(reveal).toHaveBeenCalledWith("/other/project", "/other/project/a.ts")
  })

  it("falls back to the bound Pro IDE", async () => {
    await bind()
    await run("action.editor.reveal", { path: "a.ts" })
    expect(reveal).toHaveBeenCalledWith(BOUND, `${BOUND}/a.ts`)
  })

  it("fails non-retryably, naming the node, when nothing is bound", async () => {
    // No retry can make "the user never opened the IDE" become true.
    await expect(run("action.editor.reveal", { path: "a.ts" })).rejects.toThrow(
      /action\.editor\.reveal: no Pro IDE is bound/
    )
    expect(reveal).not.toHaveBeenCalled()
  })

  it("does not start code-server just because it was addressed", async () => {
    await bind()
    await run("action.editor.reveal", { path: "a.ts" })
    expect(ensure).not.toHaveBeenCalled()
  })

  it("starts it when the node opted in, before acting", async () => {
    await bind()
    await run("action.editor.reveal", { path: "a.ts", autoStart: true })
    expect(ensure).toHaveBeenCalledWith(BOUND)
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(reveal.mock.invocationCallOrder[0])
  })
})

describe("path handling", () => {
  it("joins a relative path onto the resolved root", async () => {
    await bind()
    await run("action.editor.open", { path: "src/index.ts" })
    expect(driveOpen).toHaveBeenCalledWith(BOUND, `${BOUND}/src/index.ts`, undefined, undefined)
  })

  it("passes an absolute path through untouched", async () => {
    await bind()
    await run("action.editor.open", { path: "/tmp/scratch.ts" })
    expect(driveOpen).toHaveBeenCalledWith(BOUND, "/tmp/scratch.ts", undefined, undefined)
  })

  it("passes a Windows absolute path through untouched", async () => {
    await bind("C:\\work\\proj")
    await run("action.editor.open", { path: "C:\\work\\proj\\a.ts" })
    expect(driveOpen).toHaveBeenCalledWith(
      "C:\\work\\proj",
      "C:\\work\\proj\\a.ts",
      undefined,
      undefined
    )
  })

  it("does not double a separator when the root ends in one", async () => {
    await bind("/Users/dev/proj/")
    await run("action.editor.reveal", { path: "a.ts" })
    expect(reveal).toHaveBeenCalledWith("/Users/dev/proj/", "/Users/dev/proj/a.ts")
  })

  it("strips a stray leading backslash before joining", async () => {
    // `startsWith("/")` does not catch it and it is not a drive path, so it
    // reaches the join branch and would otherwise produce a doubled separator.
    await bind("/Users/dev/proj")
    await run("action.editor.reveal", { path: "\\a.ts" })
    expect(reveal).toHaveBeenCalledWith("/Users/dev/proj", "/Users/dev/proj/a.ts")
  })
})

describe("action.editor.open", () => {
  it("reveals a 1-based position", async () => {
    await bind()
    const r = await run("action.editor.open", { path: "a.ts", line: 42, column: 7 })
    expect(driveOpen).toHaveBeenCalledWith(BOUND, `${BOUND}/a.ts`, 42, 7)
    expect(r.output).toMatchObject({ root: BOUND, line: 42, column: 7 })
  })

  it("degrades to the CLI opener when the companion extension is not connected", async () => {
    // Same fallback the pane's own opener takes: a booting workbench should not
    // fail a step that only wanted to show the user a file.
    await bind()
    driveOpen.mockRejectedValueOnce(new Error("no extension connected"))
    await run("action.editor.open", { path: "a.ts" })
    expect(openFile).toHaveBeenCalledWith(BOUND, `${BOUND}/a.ts`, undefined, undefined)
  })

  it("rejects a missing path without calling the backend", async () => {
    await bind()
    await expect(run("action.editor.open", {})).rejects.toThrow(
      "action.editor.open requires a non-empty 'path'"
    )
    expect(driveOpen).not.toHaveBeenCalled()
  })

  it("ignores a non-positive line rather than sending it", async () => {
    await bind()
    await run("action.editor.open", { path: "a.ts", line: 0 })
    expect(driveOpen).toHaveBeenCalledWith(BOUND, `${BOUND}/a.ts`, undefined, undefined)
  })
})

describe("action.editor.showDiff", () => {
  it("sends the proposal and reports its size", async () => {
    await bind()
    const r = await run("action.editor.showDiff", {
      path: "a.ts",
      content: "next",
      title: "Proposed fix",
    })
    expect(showDiff).toHaveBeenCalledWith(BOUND, `${BOUND}/a.ts`, "next", "Proposed fix")
    expect(r.output).toMatchObject({ title: "Proposed fix", bytes: 4 })
  })

  it("accepts empty content — that is a real proposal, not a missing param", async () => {
    await bind()
    await run("action.editor.showDiff", { path: "a.ts", content: "" })
    expect(showDiff).toHaveBeenCalledWith(BOUND, `${BOUND}/a.ts`, "", undefined)
  })

  it("rejects absent content", async () => {
    await bind()
    await expect(run("action.editor.showDiff", { path: "a.ts" })).rejects.toThrow(
      "action.editor.showDiff requires a string 'content'"
    )
  })
})

describe("action.editor.readActive", () => {
  it("passes a clean snapshot through", async () => {
    await bind()
    const r = await run("action.editor.readActive", {})
    expect(readActive).toHaveBeenCalledWith(BOUND)
    expect(r.output).toMatchObject({ root: BOUND, redacted: false, selectedText: "const x = 1" })
  })

  it("withholds the text-bearing fields when the real PII gate trips", async () => {
    // Driven through the production `@cognia/redact` gate, not a stub: this
    // node's output flows into expressions, later agent turns and the persisted
    // run log, so the screening has to be the real one.
    await bind()
    readActive.mockResolvedValueOnce({
      ...CLEAN_ACTIVE,
      selectedText: 'const owner = "alice.smith@example.com"',
    })
    const r = await run("action.editor.readActive", {})
    const output = r.output as Record<string, unknown>
    expect(output.redacted).toBe(true)
    expect(output.selectedText).toBeUndefined()
    expect(output.openEditors).toBeUndefined()
    // The shape survives so a workflow can still branch on "an editor is focused".
    expect(output.openEditorCount).toBe(1)
    expect(output.selection).toEqual(CLEAN_ACTIVE.selection)
  })
})

describe("action.editor.applyEdit", () => {
  it("reflects a written file as an undo-able edit", async () => {
    await bind()
    await run("action.editor.applyEdit", { path: "a.ts", line: 5 })
    expect(driveApplyEdit).toHaveBeenCalledWith(BOUND, `${BOUND}/a.ts`, 5, undefined)
  })

  it("rejects a missing path", async () => {
    await bind()
    await expect(run("action.editor.applyEdit", {})).rejects.toThrow(
      "action.editor.applyEdit requires a non-empty 'path'"
    )
  })
})

describe("action.editor.saveAll", () => {
  it("flushes every dirty buffer by default", async () => {
    await bind()
    const r = await run("action.editor.saveAll", {})
    expect(saveAll).toHaveBeenCalledWith(BOUND, undefined)
    expect(r.decision).toBe("success")
    expect(r.output).toMatchObject({ path: null, saved: ["/repo/a.ts"], failed: [] })
  })

  it("narrows to one file when asked", async () => {
    await bind()
    await run("action.editor.saveAll", { path: "a.ts" })
    expect(saveAll).toHaveBeenCalledWith(BOUND, `${BOUND}/a.ts`)
  })

  it("routes a partial flush down the failure branch without throwing", async () => {
    // A buffer that will not flush is usually read-only or externally deleted;
    // the author decides whether that matters, so it is data, not a throw.
    await bind()
    saveAll.mockResolvedValueOnce({ saved: [], failed: ["/repo/locked.ts"] })
    const r = await run("action.editor.saveAll", {})
    expect(r.decision).toBe("failure")
    expect(r.output).toMatchObject({ failed: ["/repo/locked.ts"] })
  })
})
