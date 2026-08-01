/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useRecorderStore } from "@/stores/skills/recorder-store"
import type { RecordedStep } from "@/lib/skills/recording/types"

import { StageRecording } from "./stage-recording"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"

function step(seq: number): RecordedStep {
  return { seq, tsMs: seq * 100, kind: "click" }
}

function store() {
  return useRecorderStore.getState()
}

/** Drive the store into a live, window-scoped recording. */
function live() {
  store().dispatch({ type: "OPEN", source: "toolbar" })
  store().dispatch({ type: "PREFLIGHT_START" })
  store().dispatch({ type: "PREFLIGHT_OK" })
  store().dispatch({
    type: "NATIVE_STARTED",
    recordingId: RECORDING,
    startedAt: Date.now(),
    scope: { kind: "window", windowId: 1, processId: 2, appName: "Safari", title: "Invoices" },
    limits: { maxDurationMs: 3_600_000, maxSteps: 500, maxBundleBytes: 1, maxGlobalBytes: 1 },
  })
}

function renderStage() {
  const handlers = {
    onPause: jest.fn(),
    onResume: jest.fn(),
    onUndo: jest.fn(),
    onFinish: jest.fn(),
    onHide: jest.fn(),
  }
  render(<StageRecording {...handlers} />)
  return handlers
}

beforeEach(() => {
  useRecorderStore.getState().reset()
})

describe("live status", () => {
  it("announces the step count politely, not assertively", () => {
    // A screen-reader user performing the workflow does not want every click
    // read back over what they are actually doing.
    live()
    store().appendStep(step(1))
    renderStage()
    const status = screen.getByText(/recording\.live/)
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).toHaveTextContent('"count":1')
  })

  it("names the scope it is confined to", () => {
    live()
    renderStage()
    expect(screen.getByText(/Safari — Invoices/)).toBeInTheDocument()
  })

  it("switches to the paused wording", () => {
    live()
    store().dispatch({ type: "PAUSE" })
    renderStage()
    expect(screen.getByText(/recording\.paused/)).toBeInTheDocument()
    expect(screen.queryByText(/recording\.live/)).not.toBeInTheDocument()
  })
})

describe("controls", () => {
  it("offers pause while running", async () => {
    live()
    const { onPause } = renderStage()
    await userEvent.click(screen.getByRole("button", { name: /recording\.pause/ }))
    expect(onPause).toHaveBeenCalled()
  })

  it("offers resume while paused", async () => {
    live()
    store().dispatch({ type: "PAUSE" })
    const { onResume } = renderStage()
    await userEvent.click(screen.getByRole("button", { name: /recording\.resume/ }))
    expect(onResume).toHaveBeenCalled()
  })

  it("disables undo until there is something to undo", async () => {
    live()
    const { onUndo } = renderStage()
    expect(screen.getByRole("button", { name: /recording\.undo/ })).toBeDisabled()

    act(() => store().appendStep(step(1)))
    await userEvent.click(screen.getByRole("button", { name: /recording\.undo/ }))
    expect(onUndo).toHaveBeenCalled()
  })

  it("finishes the recording", async () => {
    live()
    const { onFinish } = renderStage()
    await userEvent.click(screen.getByRole("button", { name: /recording\.finish/ }))
    expect(onFinish).toHaveBeenCalled()
  })

  it("hides the panel without stopping — and says so", async () => {
    live()
    const { onHide } = renderStage()
    await userEvent.click(screen.getByRole("button", { name: "recording.hideSheet" }))
    expect(onHide).toHaveBeenCalled()
    expect(screen.getByText("recording.hideSheetHint")).toBeInTheDocument()
  })

  it("repeats the shortcuts that work from anywhere", () => {
    // The user is about to leave the app; a control they can only reach here
    // is a control they cannot use.
    live()
    renderStage()
    expect(screen.getByText(/recording\.shortcuts/)).toBeInTheDocument()
  })
})

describe("limits", () => {
  it("stays quiet below the warning threshold", () => {
    live()
    store().dispatch({ type: "USAGE", usage: [{ kind: "steps", used: 100, limit: 500 }] })
    renderStage()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("shows the worst limit once it passes 80%", () => {
    live()
    store().dispatch({
      type: "USAGE",
      usage: [
        { kind: "steps", used: 410, limit: 500 },
        { kind: "bundleBytes", used: 240, limit: 250 },
      ],
    })
    renderStage()
    expect(screen.getByRole("progressbar")).toBeInTheDocument()
    // 96% (bundle bytes) beats 82% (steps) — the one about to stop it.
    expect(screen.getByText(/"kind":"bundleBytes"/)).toBeInTheDocument()
  })

  it("ignores a limit reported with no ceiling", () => {
    live()
    store().dispatch({ type: "USAGE", usage: [{ kind: "steps", used: 400, limit: 0 }] })
    renderStage()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
})

describe("out-of-scope actions", () => {
  it("reports only a count — never what was ignored", () => {
    live()
    store().dispatch({ type: "STOP_REQUESTED" })
    store().dispatch({ type: "STOPPED", steps: [], ignoredCount: 4, bundleId: RECORDING })
    renderStage()
    expect(screen.getByText(/recording\.ignored.*"count":4/)).toBeInTheDocument()
  })

  it("says nothing when everything was in scope", () => {
    live()
    renderStage()
    expect(screen.queryByText(/recording\.ignored/)).not.toBeInTheDocument()
  })
})
