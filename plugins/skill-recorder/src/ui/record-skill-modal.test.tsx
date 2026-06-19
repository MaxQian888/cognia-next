/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let recordingState: {
  status: string
  steps: unknown[]
  error: string | null
  start: jest.Mock
  stop: jest.Mock
  cancel: jest.Mock
}
let generationState: { generating: boolean; generate: jest.Mock }

jest.mock("@/hooks/skills/use-skill-recording", () => ({
  useSkillRecording: () => recordingState,
}))
jest.mock("@/hooks/skills/use-skill-generation", () => ({
  useSkillGeneration: () => generationState,
}))

const createSkillMock = jest.fn()
jest.mock("@/lib/db/skills", () => ({ createSkill: (...a: unknown[]) => createSkillMock(...a) }))

const openEditMock = jest.fn()
jest.mock("@/stores/skills", () => ({
  useSkillsStore: { getState: () => ({ openEdit: openEditMock }) },
}))

const toastInfo = jest.fn()
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    info: (...a: unknown[]) => toastInfo(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { RecordSkillModal } from "./record-skill-modal"

const onClose = jest.fn()

beforeEach(() => {
  createSkillMock.mockReset().mockResolvedValue({ id: "new-skill", name: "Export report" })
  openEditMock.mockReset()
  toastInfo.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  onClose.mockReset()
  recordingState = {
    status: "idle",
    steps: [],
    error: null,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
  }
  generationState = { generating: false, generate: jest.fn() }
})

describe("RecordSkillModal", () => {
  it("starts recording when Start is clicked", async () => {
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    await userEvent.click(screen.getByText("recorder.start"))
    expect(recordingState.start).toHaveBeenCalledWith({ inlineScreenshots: true })
  })

  it("shows the live step list while recording", () => {
    recordingState.status = "recording"
    recordingState.steps = [{ seq: 1, kind: "click", element: { name: "Save" } }]
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    expect(screen.getByText("recorder.recording")).toBeInTheDocument()
    expect(screen.getByText("Save")).toBeInTheDocument()
    expect(screen.getByText("recorder.stop")).toBeInTheDocument()
  })

  it("generates and persists a generated skill on stop", async () => {
    recordingState.status = "recording"
    recordingState.stop.mockResolvedValue({
      sessionId: "s",
      startedAt: 0,
      endedAt: 1,
      observations: [{ seq: 1, tsMs: 0, kind: "click" }],
      monitors: [],
    })
    generationState.generate.mockResolvedValue({
      name: "Export report",
      description: "d",
      content: "## Steps\n1. x",
      tags: ["export"],
      category: "productivity",
      allowedTools: [],
    })
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    await act(async () => {
      await userEvent.click(screen.getByText("recorder.stop"))
    })
    expect(createSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "generated", name: "Export report" })
    )
    expect(openEditMock).toHaveBeenCalledWith("new-skill")
    expect(onClose).toHaveBeenCalled()
  })

  it("warns and does not save when the recording captured no steps", async () => {
    recordingState.status = "recording"
    recordingState.stop.mockResolvedValue({
      sessionId: "s",
      startedAt: 0,
      endedAt: 1,
      observations: [],
      monitors: [],
    })
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    await act(async () => {
      await userEvent.click(screen.getByText("recorder.stop"))
    })
    expect(toastInfo).toHaveBeenCalledWith("recorder.emptyTrace")
    expect(createSkillMock).not.toHaveBeenCalled()
  })

  it("toggles the attach-screenshots checkbox", async () => {
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    const checkbox = screen.getByRole("checkbox")
    expect(checkbox).toBeChecked()
    await userEvent.click(checkbox)
    expect(checkbox).not.toBeChecked()
  })

  it("omits screenshot resources when attach is unchecked", async () => {
    recordingState.stop.mockResolvedValue({
      sessionId: "s",
      startedAt: 0,
      endedAt: 1,
      observations: [{ seq: 1, tsMs: 0, kind: "click" }],
      monitors: [],
    })
    generationState.generate.mockResolvedValue({
      name: "X",
      description: "d",
      content: "c",
      tags: [],
      category: "custom",
      allowedTools: [],
    })
    const { rerender } = render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    // Uncheck while idle (local state persists), then re-render into the
    // recording state and stop — the same component instance keeps attach=false.
    await userEvent.click(screen.getByRole("checkbox"))
    recordingState.status = "recording"
    rerender(<RecordSkillModal onClose={onClose} modalId="m1" />)
    await act(async () => {
      await userEvent.click(screen.getByText("recorder.stop"))
    })
    expect(createSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "generated", resources: undefined })
    )
  })

  it("shows the generating state", () => {
    generationState.generating = true
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    expect(screen.getByText("recorder.generating")).toBeInTheDocument()
  })

  it("shows a recording error", () => {
    recordingState.status = "recording"
    recordingState.error = "hook blocked"
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    expect(screen.getByText("hook blocked")).toBeInTheDocument()
  })

  it("does not surface the desktop-only sentinel as an error", () => {
    recordingState.error = "desktop-only"
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    expect(screen.queryByText("desktop-only")).not.toBeInTheDocument()
  })

  it("toasts on a save failure without closing", async () => {
    recordingState.status = "recording"
    recordingState.stop.mockResolvedValue({
      sessionId: "s",
      startedAt: 0,
      endedAt: 1,
      observations: [{ seq: 1, tsMs: 0, kind: "click" }],
      monitors: [],
    })
    generationState.generate.mockResolvedValue({
      name: "X",
      description: "d",
      content: "c",
      tags: [],
      category: "custom",
      allowedTools: [],
    })
    createSkillMock.mockRejectedValue(new Error("db down"))
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    await act(async () => {
      await userEvent.click(screen.getByText("recorder.stop"))
    })
    expect(toastError).toHaveBeenCalledWith("recorder.generateFailed")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("stays put when generation yields no draft", async () => {
    recordingState.status = "recording"
    recordingState.stop.mockResolvedValue({
      sessionId: "s",
      startedAt: 0,
      endedAt: 1,
      observations: [{ seq: 1, tsMs: 0, kind: "click" }],
      monitors: [],
    })
    generationState.generate.mockResolvedValue(null)
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    await act(async () => {
      await userEvent.click(screen.getByText("recorder.stop"))
    })
    expect(createSkillMock).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("swallows a start rejection (surfaced via recording.error)", async () => {
    recordingState.start.mockRejectedValue(new Error("nope"))
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    await act(async () => {
      await userEvent.click(screen.getByText("recorder.start"))
    })
    expect(recordingState.start).toHaveBeenCalled()
  })

  it("cancels recording and closes", async () => {
    recordingState.status = "recording"
    render(<RecordSkillModal onClose={onClose} modalId="m1" />)
    await act(async () => {
      await userEvent.click(screen.getByText("recorder.cancel"))
    })
    expect(recordingState.cancel).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
