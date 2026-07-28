/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SelectionToolbarView } from "./selection-toolbar-view"

const listeners = new Map<string, (event: { payload: unknown }) => void>()
const listenMock = jest.fn(
  async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler)
    return jest.fn()
  }
)

jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...(args as [string, never])),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
}))

const executeMock = jest.fn().mockResolvedValue(undefined)
const currentMock = jest.fn()
const revealMock = jest.fn().mockResolvedValue(undefined)
const interactiveMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_CANDIDATE_EVENT: "selection://candidate",
  SELECTION_DISMISS_EVENT: "selection://dismiss",
  executeSelectionToolbarAction: (...args: unknown[]) => executeMock(...args),
  getCurrentSelectionCandidate: () => currentMock(),
  revealSelectionToolbar: () => revealMock(),
  setSelectionToolbarInteractive: (...args: unknown[]) => interactiveMock(...args),
}))

const getPrefMock = jest.fn()
const setPrefMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/store", () => ({
  getPref: (...args: unknown[]) => getPrefMock(...args),
  setPref: (...args: unknown[]) => setPrefMock(...args),
}))

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}))

const candidate = {
  id: "candidate-1",
  text: "selected text",
  sourceApp: "TextEdit",
  sourceTitle: "Draft",
  origin: "accessibility" as const,
  capturedAt: 1,
  truncated: false,
}

beforeEach(() => {
  listeners.clear()
  jest.clearAllMocks()
  currentMock.mockResolvedValue(candidate)
  getPrefMock.mockResolvedValue(null)
  global.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }
})

it("hydrates the current candidate and reveals the native window after paint", async () => {
  render(<SelectionToolbarView />)

  expect(await screen.findByRole("button", { name: "copy" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "explain" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "translate" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "ask" })).toBeInTheDocument()
  await waitFor(() => expect(revealMock).toHaveBeenCalled())
  expect(document.documentElement).toHaveAttribute("data-selection-toolbar")
})

it("executes explicit actions against the current candidate", async () => {
  render(<SelectionToolbarView />)
  fireEvent.click(await screen.findByRole("button", { name: "copy" }))
  fireEvent.click(screen.getByRole("button", { name: "explain" }))
  fireEvent.click(screen.getByRole("button", { name: "translate" }))
  fireEvent.click(screen.getByRole("button", { name: "ask" }))

  await waitFor(() => {
    expect(executeMock).toHaveBeenCalledWith("candidate-1", { kind: "copy" })
    expect(executeMock).toHaveBeenCalledWith("candidate-1", { kind: "explain" })
    expect(executeMock).toHaveBeenCalledWith("candidate-1", {
      kind: "translate",
      targetLocale: "en",
    })
    expect(executeMock).toHaveBeenCalledWith("candidate-1", { kind: "ask" })
  })
})

it("reacts to native candidate and dismiss events", async () => {
  render(<SelectionToolbarView />)
  await screen.findByRole("button", { name: "copy" })

  await act(async () => {
    listeners.get("selection://dismiss")?.({ payload: null })
  })
  expect(screen.queryByRole("button", { name: "copy" })).not.toBeInTheDocument()

  await act(async () => {
    listeners.get("selection://candidate")?.({
      payload: { ...candidate, id: "candidate-2", truncated: true },
    })
  })
  expect(await screen.findByText("truncated")).toBeInTheDocument()
})
