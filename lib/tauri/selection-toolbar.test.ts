import { invoke } from "@tauri-apps/api/core"

import {
  captureClipboardSelection,
  executeSelectionToolbarAction,
  getCurrentSelectionCandidate,
  getSelectionToolbarStatus,
  revealSelectionToolbar,
  setSelectionToolbarInteractive,
  startSelectionToolbar,
  stopSelectionToolbar,
  takePendingSelectionStage,
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
    args: { disabledApps: ["1Password"] },
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
