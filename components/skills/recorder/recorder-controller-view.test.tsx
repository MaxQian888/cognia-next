/** @jest-environment jsdom */

import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const recordStatus = jest.fn()
const recordPause = jest.fn()
const recordResume = jest.fn()
const recordUndoLast = jest.fn()
const recordStop = jest.fn()
const setCollapsed = jest.fn()
const beginDrag = jest.fn()
const onRecordEvent = jest.fn(() => () => {})

jest.mock("@/lib/skills/recording/recorder-client", () => ({
  RECORDER_CONTROLLER_EVENT: "recorder:controller",
  onRecordEvent: (...a: unknown[]) => onRecordEvent(...(a as [])),
  recordStatus: () => recordStatus(),
  recordPause: () => recordPause(),
  recordResume: () => recordResume(),
  recordUndoLast: () => recordUndoLast(),
  recordStop: () => recordStop(),
  recorderControllerSetCollapsed: (v: boolean) => setCollapsed(v),
  recorderControllerBeginDrag: () => beginDrag(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

import { RecorderControllerView } from "./recorder-controller-view"

function status(overrides: Record<string, unknown> = {}) {
  return {
    recording: true,
    phase: "recording",
    stepCount: 3,
    startedAt: Date.now() - 65_000,
    usage: [],
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  recordStatus.mockResolvedValue(status())
  setCollapsed.mockResolvedValue(undefined)
  beginDrag.mockResolvedValue(undefined)
  for (const fn of [recordPause, recordResume, recordUndoLast, recordStop]) {
    fn.mockResolvedValue(undefined)
  }
})

describe("RecorderControllerView", () => {
  it("shows elapsed time and the live step count", async () => {
    render(<RecorderControllerView />)
    await waitFor(() => expect(screen.getByTestId("recorder-controller")).toBeInTheDocument())
    expect(screen.getByText("1:05")).toBeInTheDocument()
    expect(screen.getByText(/3/)).toBeInTheDocument()
  })

  it("offers no dismiss control", async () => {
    // The controller window's capability grants no allow-close and no
    // allow-hide, so a recording can always be stopped. A close button here
    // would be a UI affordance the ACL deliberately withholds.
    render(<RecorderControllerView />)
    await waitFor(() => expect(screen.getByTestId("recorder-controller")).toBeInTheDocument())
    for (const label of ["Close", "Hide", "Dismiss"]) {
      expect(screen.queryByLabelText(new RegExp(label, "i"))).not.toBeInTheDocument()
    }
  })

  it("pauses and resumes through the native client", async () => {
    const user = userEvent.setup()
    render(<RecorderControllerView />)
    await waitFor(() => expect(screen.getByTestId("recorder-controller")).toBeInTheDocument())

    await user.click(screen.getByLabelText("Pause"))
    expect(recordPause).toHaveBeenCalledTimes(1)

    recordStatus.mockResolvedValue(status({ phase: "paused" }))
    await waitFor(() => expect(screen.getByLabelText("Resume")).toBeInTheDocument())
    await user.click(screen.getByLabelText("Resume"))
    expect(recordResume).toHaveBeenCalledTimes(1)
  })

  it("stops the recording from the finish control", async () => {
    const user = userEvent.setup()
    render(<RecorderControllerView />)
    await waitFor(() => expect(screen.getByTestId("recorder-controller")).toBeInTheDocument())
    await user.click(screen.getByLabelText("Finish"))
    expect(recordStop).toHaveBeenCalledTimes(1)
  })

  it("disables undo until there is a step to undo", async () => {
    recordStatus.mockResolvedValue(status({ stepCount: 0 }))
    render(<RecorderControllerView />)
    await waitFor(() => expect(screen.getByTestId("recorder-controller")).toBeInTheDocument())
    expect(screen.getByLabelText("Undo last step")).toBeDisabled()
  })

  it("collapses to a pill that still shows elapsed time and can expand back", async () => {
    const user = userEvent.setup()
    render(<RecorderControllerView />)
    await waitFor(() => expect(screen.getByTestId("recorder-controller")).toBeInTheDocument())

    await user.click(screen.getByLabelText("Collapse controller"))
    expect(setCollapsed).toHaveBeenCalledWith(true)
    const pill = await screen.findByTestId("recorder-controller-collapsed")
    expect(pill).toHaveTextContent("1:05")

    await user.click(screen.getByLabelText("Expand controller"))
    expect(setCollapsed).toHaveBeenCalledWith(false)
  })

  it("keeps the last known status when a poll fails", async () => {
    render(<RecorderControllerView />)
    await waitFor(() => expect(screen.getByText("1:05")).toBeInTheDocument())
    recordStatus.mockRejectedValue(new Error("backend gone"))
    // A failed poll must not blank an always-on-top window over the user's work.
    await waitFor(() => expect(screen.getByTestId("recorder-controller")).toBeInTheDocument())
    expect(screen.getByText("1:05")).toBeInTheDocument()
  })
})
