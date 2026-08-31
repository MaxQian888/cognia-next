import { invoke } from "@tauri-apps/api/core"

import {
  captureClipboardSelection,
  copySelectionActionResult,
  executeSelectionToolbarAction,
  finishSelectionToolbar,
  getCurrentSelectionCandidate,
  getSelectionToolbarStatus,
  listShortcutChords,
  resizeSelectionToolbar,
  revealSelectionToolbar,
  setSelectionToolbarInteractive,
  setSelectionToolbarKeepAlive,
  startSelectionToolbar,
  stopSelectionToolbar,
  takePendingSelectionStage,
  replaceCurrentSelection,
  undoSelectionReplacement,
} from "./selection-toolbar"

jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

const invokeMock = jest.mocked(invoke)

beforeEach(() => {
  invokeMock.mockReset()
})

it("maps selection toolbar lifecycle calls to their native commands", async () => {
  invokeMock.mockResolvedValue({ running: true, hasCandidate: false })

  await expect(startSelectionToolbar(["1Password"])).resolves.toEqual({
    running: true,
    hasCandidate: false,
  })
  await getSelectionToolbarStatus()
  await stopSelectionToolbar()

  expect(invokeMock).toHaveBeenNthCalledWith(1, "selection_toolbar_start", {
    args: { mode: "automatic", disabledApps: ["1Password"], disabledSites: [] },
  })
  expect(invokeMock).toHaveBeenNthCalledWith(2, "selection_toolbar_status")
  expect(invokeMock).toHaveBeenNthCalledWith(3, "selection_toolbar_stop")
})

it("maps candidate and action calls without changing the captured text", async () => {
  invokeMock.mockResolvedValue(undefined)

  await getCurrentSelectionCandidate()
  await captureClipboardSelection()
  await takePendingSelectionStage()
  await executeSelectionToolbarAction("candidate-1", {
    kind: "translate",
    targetLocale: "zh-CN",
  })
  await revealSelectionToolbar()
  await setSelectionToolbarInteractive(true)

  expect(invokeMock).toHaveBeenNthCalledWith(1, "selection_toolbar_current_candidate")
  expect(invokeMock).toHaveBeenNthCalledWith(2, "selection_toolbar_capture_clipboard")
  expect(invokeMock).toHaveBeenNthCalledWith(3, "selection_toolbar_take_pending_stage")
  expect(invokeMock).toHaveBeenNthCalledWith(4, "selection_toolbar_execute", {
    candidateId: "candidate-1",
    action: { kind: "translate", targetLocale: "zh-CN" },
  })
  expect(invokeMock).toHaveBeenNthCalledWith(5, "selection_toolbar_reveal")
  expect(invokeMock).toHaveBeenNthCalledWith(6, "selection_toolbar_set_interactive", {
    interactive: true,
  })
})

it("maps validated replacement and undo to dedicated native commands", async () => {
  invokeMock
    .mockResolvedValueOnce({ replaced: true, undoExpiresAt: 42 })
    .mockResolvedValueOnce(true)

  await expect(replaceCurrentSelection("candidate-1", "replacement")).resolves.toEqual({
    replaced: true,
    undoExpiresAt: 42,
  })
  await expect(undoSelectionReplacement("candidate-1")).resolves.toBe(true)

  expect(invokeMock).toHaveBeenNthCalledWith(1, "selection_toolbar_replace", {
    candidateId: "candidate-1",
    text: "replacement",
  })
  expect(invokeMock).toHaveBeenNthCalledWith(2, "selection_toolbar_undo", {
    candidateId: "candidate-1",
  })
})

it("copies normalized action output through the native candidate boundary", async () => {
  invokeMock.mockResolvedValue(undefined)
  await copySelectionActionResult("candidate-1", "result")
  expect(invokeMock).toHaveBeenCalledWith("selection_toolbar_copy_result", {
    candidateId: "candidate-1",
    text: "result",
  })
})

it("sends the measured window box and every opaque content rect", async () => {
  invokeMock.mockResolvedValue({ placement: "below" })

  const capsule = { x: 20, y: 20, width: 240, height: 48 }
  const localeList = { x: 40, y: 76, width: 160, height: 120 }
  await expect(resizeSelectionToolbar(280, 88, [capsule, localeList])).resolves.toEqual({
    placement: "below",
  })

  // These rects are what Rust hit-tests. Sending only the window box is what
  // made the shadow padding a dead zone; sending only the capsule is what made
  // a click in the open language list dismiss the toolbar.
  expect(invokeMock).toHaveBeenCalledWith("selection_toolbar_resize", {
    width: 280,
    height: 88,
    hitRects: [capsule, localeList],
  })
})

it("maps keep-alive and finish to their native commands", async () => {
  invokeMock.mockResolvedValue(undefined)

  await setSelectionToolbarKeepAlive(true)
  await finishSelectionToolbar("candidate-1")

  expect(invokeMock).toHaveBeenNthCalledWith(1, "selection_toolbar_set_keep_alive", {
    keepAlive: true,
  })
  expect(invokeMock).toHaveBeenNthCalledWith(2, "selection_toolbar_finish", {
    candidateId: "candidate-1",
  })
})

it("reads bound chords as an id-to-chord map", async () => {
  invokeMock.mockResolvedValue([
    { id: "selection.copy", chord: "alt+shift+1" },
    { id: "tray.show", chord: "ctrl+shift+space" },
  ])

  await expect(listShortcutChords()).resolves.toEqual({
    "selection.copy": "alt+shift+1",
    "tray.show": "ctrl+shift+space",
  })
  expect(invokeMock).toHaveBeenCalledWith("shortcut_list")
})

describe("off Tauri", () => {
  // The same bundle powers the browser dev server, where none of these commands
  // exist. Every entry point has to degrade rather than throw.
  beforeEach(() => {
    jest.resetModules()
    jest.doMock("@/lib/tauri", () => ({ isTauri: () => false }))
  })

  afterEach(() => {
    jest.dontMock("@/lib/tauri")
    jest.resetModules()
  })

  it("returns inert values without invoking anything", async () => {
    const bridge = await import("./selection-toolbar")

    await expect(bridge.startSelectionToolbar()).resolves.toEqual({
      running: false,
      hasCandidate: false,
      mode: "off",
      accessibility: "unknown",
      inputMonitoring: "unknown",
      screenRecording: "unknown",
      uia: "unknown",
      ocrAvailable: false,
      shortcutActivationActive: false,
      replaceAvailable: false,
    })
    await expect(bridge.stopSelectionToolbar()).resolves.toEqual({
      running: false,
      hasCandidate: false,
      mode: "off",
      accessibility: "unknown",
      inputMonitoring: "unknown",
      screenRecording: "unknown",
      uia: "unknown",
      ocrAvailable: false,
      shortcutActivationActive: false,
      replaceAvailable: false,
    })
    await expect(bridge.getSelectionToolbarStatus()).resolves.toEqual({
      running: false,
      hasCandidate: false,
      mode: "off",
      accessibility: "unknown",
      inputMonitoring: "unknown",
      screenRecording: "unknown",
      uia: "unknown",
      ocrAvailable: false,
      shortcutActivationActive: false,
      replaceAvailable: false,
    })
    await expect(bridge.getCurrentSelectionCandidate()).resolves.toBeNull()
    await expect(bridge.captureClipboardSelection()).resolves.toBeNull()
    await expect(bridge.replaceCurrentSelection("c1", "text")).resolves.toEqual({
      replaced: false,
      reason: "sourceUnavailable",
    })
    await expect(bridge.undoSelectionReplacement("c1")).resolves.toBe(false)
    await bridge.copySelectionActionResult("c1", "text")
    await expect(bridge.takePendingSelectionStage()).resolves.toBeNull()
    await expect(bridge.listShortcutChords()).resolves.toEqual({})
    // A placeholder placement keeps the renderer's layout deterministic.
    await expect(
      bridge.resizeSelectionToolbar(1, 1, [{ x: 0, y: 0, width: 1, height: 1 }])
    ).resolves.toEqual({ placement: "above" })

    await bridge.executeSelectionToolbarAction("c1", { kind: "copy" })
    await bridge.revealSelectionToolbar()
    await bridge.setSelectionToolbarInteractive(true)
    await bridge.setSelectionToolbarKeepAlive(true)
    await bridge.finishSelectionToolbar("c1")

    expect(invokeMock).not.toHaveBeenCalled()
  })
})
