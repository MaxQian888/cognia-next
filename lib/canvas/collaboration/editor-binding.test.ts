/**
 * @jest-environment jsdom
 */

import {
  awarenessUserFrom,
  bindMonacoEditor,
  codeMirrorCollabExtensions,
  presenceStylesheet,
  resolvePresenceTimeout,
  MAX_PRESENCE_TIMEOUT_MS,
  MIN_PRESENCE_TIMEOUT_MS,
  type CanvasPresenceSettings,
} from "./editor-binding"
import type { Participant } from "@/types/canvas/collaboration"

// Defined inside the factories and re-imported: a variable referenced from a
// `jest.mock` factory hits the temporal dead zone, and wrapping a constructor
// in an arrow makes it un-`new`-able.
jest.mock("y-monaco", () => ({ MonacoBinding: jest.fn() }))
jest.mock("y-codemirror.next", () => ({ yCollab: jest.fn(() => ["collab-extension"]) }))

import { MonacoBinding as MonacoBindingImport } from "y-monaco"
import { yCollab as yCollabImport } from "y-codemirror.next"

const MonacoBinding = MonacoBindingImport as unknown as jest.Mock
const yCollab = yCollabImport as unknown as jest.Mock
const destroy = jest.fn()

const ALL_ON: CanvasPresenceSettings = {
  showCursors: true,
  showSelections: true,
  cursorSmoothing: true,
  presenceTimeout: 30_000,
}

beforeEach(() => {
  jest.clearAllMocks()
  MonacoBinding.mockImplementation(() => ({ destroy }))
  yCollab.mockImplementation(() => ["collab-extension"])
})

describe("presenceStylesheet", () => {
  it("draws everything when every switch is on", () => {
    const css = presenceStylesheet({ ...ALL_ON, cursorSmoothing: false })
    expect(css).toBe("")
  })

  it("hides the caret in both editors when cursors are off", () => {
    // Both bindings are covered because the same setting has to mean the same
    // thing whether the user is on desktop Monaco or mobile CodeMirror.
    const css = presenceStylesheet({ ...ALL_ON, showCursors: false, cursorSmoothing: false })
    expect(css).toContain(".yRemoteSelectionHead")
    expect(css).toContain(".cm-ySelectionCaret")
    expect(css).toContain("display: none")
  })

  it("hides the selection highlight without hiding the caret", () => {
    const css = presenceStylesheet({ ...ALL_ON, showSelections: false, cursorSmoothing: false })
    expect(css).toContain(".yRemoteSelection,")
    expect(css).toContain("background-color: transparent")
    expect(css).not.toContain("display: none")
  })

  it("transitions the caret and not the highlight when smoothing is on", () => {
    // Transitioning the highlight makes a range change smear rather than glide.
    const css = presenceStylesheet(ALL_ON)
    const transition = css.split("\n").find((rule) => rule.includes("transition"))
    expect(transition).toBeDefined()
    expect(transition).toContain(".yRemoteSelectionHead")
    expect(transition).not.toContain(".yRemoteSelection,")
  })

  it("combines switches rather than letting one win", () => {
    const css = presenceStylesheet({
      showCursors: false,
      showSelections: false,
      cursorSmoothing: false,
      presenceTimeout: 1,
    })
    expect(css).toContain("background-color: transparent")
    expect(css).toContain("display: none")
  })
})

describe("resolvePresenceTimeout", () => {
  it("keeps a sensible value untouched", () => {
    expect(resolvePresenceTimeout(45_000)).toBe(45_000)
  })

  it("refuses a value that would evict everybody the moment they stop typing", () => {
    expect(resolvePresenceTimeout(0)).toBe(MIN_PRESENCE_TIMEOUT_MS)
    expect(resolvePresenceTimeout(-5)).toBe(MIN_PRESENCE_TIMEOUT_MS)
  })

  it("refuses a value that would keep ghosts in the roster forever", () => {
    expect(resolvePresenceTimeout(Number.MAX_SAFE_INTEGER)).toBe(MAX_PRESENCE_TIMEOUT_MS)
  })

  it("falls back rather than passing NaN into the protocol", () => {
    expect(resolvePresenceTimeout(Number.NaN)).toBe(30_000)
  })
})

describe("awarenessUserFrom", () => {
  it("publishes the fields both bindings read for a remote caret", () => {
    // `name` and `color` are the names y-monaco and y-codemirror.next look
    // for. Renaming either leaves every remote cursor untitled and grey.
    const participant: Participant = {
      id: "p-1",
      name: "Ada",
      color: "#ff0000",
      lastActive: new Date(),
      isOnline: true,
    }
    expect(awarenessUserFrom(participant)).toEqual({
      name: "Ada",
      color: "#ff0000",
      participantId: "p-1",
    })
  })
})

describe("bindMonacoEditor", () => {
  const ytext = {} as never
  const awareness = {} as never

  it("binds the model and hands back a teardown", async () => {
    const model = { id: "model" }
    const editor = { getModel: () => model } as never
    const teardown = await bindMonacoEditor({ ytext, awareness, settings: ALL_ON }, editor)
    expect(MonacoBinding).toHaveBeenCalledWith(ytext, model, expect.any(Set), awareness)
    teardown()
    expect(destroy).toHaveBeenCalled()
  })

  it("passes awareness even when cursors are hidden", async () => {
    // Withholding it would cost the peer's position, so turning the setting
    // back on would show nothing until they next typed. Visibility is the
    // stylesheet's business.
    const editor = { getModel: () => ({}) } as never
    await bindMonacoEditor(
      { ytext, awareness, settings: { ...ALL_ON, showCursors: false, showSelections: false } },
      editor
    )
    expect(MonacoBinding).toHaveBeenCalledWith(ytext, expect.anything(), expect.any(Set), awareness)
  })

  it("does nothing when the editor has no model yet", async () => {
    const editor = { getModel: () => null } as never
    const teardown = await bindMonacoEditor({ ytext, awareness, settings: ALL_ON }, editor)
    expect(MonacoBinding).not.toHaveBeenCalled()
    expect(() => teardown()).not.toThrow()
  })
})

describe("codeMirrorCollabExtensions", () => {
  it("returns extensions rather than applying them", async () => {
    // `LightCodeEditor` composes its own list and is shared with surfaces that
    // must stay non-collaborative.
    const ytext = {} as never
    const awareness = {} as never
    const extensions = await codeMirrorCollabExtensions({ ytext, awareness, settings: ALL_ON })
    expect(yCollab).toHaveBeenCalledWith(ytext, awareness)
    expect(extensions).toEqual([["collab-extension"]])
  })
})
