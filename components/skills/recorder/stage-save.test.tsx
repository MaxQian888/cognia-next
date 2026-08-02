/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { GeneratedDraft } from "@/lib/skills/recording/state-machine"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import type { RecordedStep } from "@/lib/skills/recording/types"

import { StageSave } from "./stage-save"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"

const DRAFT: GeneratedDraft = {
  name: "Monthly export",
  description: "Exports invoices.",
  content: "## Steps\n1. Go",
  tags: [],
  category: "custom",
  allowedTools: [],
}

function step(seq: number): RecordedStep {
  return { seq, tsMs: seq, kind: "click", element: { name: "Export" } }
}

function store() {
  return useRecorderStore.getState()
}

/** Reach the save stage with a draft in hand. */
function reachDraft() {
  store().dispatch({ type: "OPEN", source: "toolbar" })
  store().dispatch({ type: "PREFLIGHT_START" })
  store().dispatch({ type: "PREFLIGHT_OK" })
  store().dispatch({
    type: "NATIVE_STARTED",
    recordingId: RECORDING,
    startedAt: 1,
    scope: { kind: "desktop" },
    limits: { maxDurationMs: 1, maxSteps: 1, maxBundleBytes: 1, maxGlobalBytes: 1 },
  })
  store().setCapturedSteps([step(1)])
  store().dispatch({ type: "STOP_REQUESTED" })
  store().dispatch({ type: "STOPPED", steps: [step(1)], ignoredCount: 0, bundleId: RECORDING })
  store().dispatch({ type: "GENERATE_REQUESTED" })
  store().dispatch({
    type: "GENERATED",
    draft: DRAFT,
    provenance: {
      provider: "p",
      model: "m",
      locale: "en",
      redacted: false,
      generatedAt: 1,
      promptHash: "h",
    },
    asCandidate: false,
  })
}

function renderStage() {
  const handlers = {
    onSave: jest.fn(),
    onStartTrial: jest.fn(),
    onConfirmTrial: jest.fn(),
    onOpenEditor: jest.fn(),
  }
  render(<StageSave {...handlers} />)
  return handlers
}

beforeEach(() => {
  useRecorderStore.getState().reset()
})

describe("saving", () => {
  it("saves the draft", async () => {
    reachDraft()
    const { onSave } = renderStage()
    await userEvent.click(screen.getByRole("button", { name: /save\.run/ }))
    expect(onSave).toHaveBeenCalled()
  })

  it("refuses to save with no draft to save", () => {
    renderStage()
    expect(screen.getByRole("button", { name: /save\.run/ })).toBeDisabled()
  })

  it("shows progress and blocks a second click while the transaction runs", () => {
    reachDraft()
    store().dispatch({ type: "SAVE_REQUESTED" })
    renderStage()
    expect(screen.getByRole("button", { name: /save\.saving/ })).toBeDisabled()
  })

  it("reports a failed save and leaves the action available to retry", () => {
    // The transaction rolled back, so nothing the user wrote is gone.
    reachDraft()
    store().dispatch({ type: "SAVE_REQUESTED" })
    store().dispatch({
      type: "SAVE_FAILED",
      error: { code: "saveFailed", detail: "quota exceeded", retriable: true },
    })
    renderStage()
    expect(screen.getByText("save.failed")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /save\.run/ })).toBeEnabled()
  })
})

describe("after saving", () => {
  function saved() {
    reachDraft()
    store().dispatch({ type: "SAVE_REQUESTED" })
    store().dispatch({ type: "SAVED", skillId: "skill-1" })
  }

  it("says the skill was saved, and says it is off", () => {
    // A generated procedure nobody has run does not belong in every
    // conversation's system prompt on the strength of a first draft.
    saved()
    renderStage()
    expect(screen.getByText(/save\.saved.*Monthly export/)).toBeInTheDocument()
    expect(screen.getByText("save.disabledNotice")).toBeInTheDocument()
  })

  it("announces the save politely", () => {
    saved()
    renderStage()
    expect(screen.getByText(/save\.saved/)).toHaveAttribute("aria-live", "polite")
  })

  it("hides the save action once it has succeeded", () => {
    saved()
    renderStage()
    expect(screen.queryByRole("button", { name: /save\.run/ })).not.toBeInTheDocument()
  })

  it("opens the saved skill in the editor", async () => {
    saved()
    const { onOpenEditor } = renderStage()
    await userEvent.click(screen.getByRole("button", { name: "draft.openEditor" }))
    expect(onOpenEditor).toHaveBeenCalled()
  })
})

describe("controlled trial", () => {
  function saved() {
    reachDraft()
    store().dispatch({ type: "SAVE_REQUESTED" })
    store().dispatch({ type: "SAVED", skillId: "skill-1" })
  }

  it("offers the trial, and explains what it isolates", async () => {
    saved()
    const { onStartTrial } = renderStage()
    expect(screen.getByText("save.trial.description")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /save\.trial\.start/ }))
    expect(onStartTrial).toHaveBeenCalled()
  })

  it("does not offer enabling before the trial has been opened", () => {
    saved()
    renderStage()
    expect(screen.queryByRole("button", { name: "save.trial.succeeded" })).not.toBeInTheDocument()
  })

  it("offers enabling once the trial session exists", async () => {
    saved()
    store().dispatch({ type: "TRIAL_STARTED", sessionId: "session-1" })
    const { onConfirmTrial } = renderStage()
    await userEvent.click(screen.getByRole("button", { name: "save.trial.succeeded" }))
    expect(onConfirmTrial).toHaveBeenCalled()
  })

  it("enabling is a separate, explicit act — never the trial itself", () => {
    saved()
    store().dispatch({ type: "TRIAL_STARTED", sessionId: "session-1" })
    renderStage()
    expect(store().trialConfirmed).toBe(false)
    expect(screen.getByText("save.trial.opened")).toBeInTheDocument()
  })

  it("confirms the skill is on once the user says the trial worked", () => {
    saved()
    store().dispatch({ type: "TRIAL_STARTED", sessionId: "session-1" })
    store().dispatch({ type: "TRIAL_CONFIRMED" })
    renderStage()
    const confirmation = screen.getByText(/save\.trial\.enabled.*Monthly export/)
    expect(confirmation).toHaveAttribute("aria-live", "polite")
    expect(screen.queryByRole("button", { name: "save.trial.succeeded" })).not.toBeInTheDocument()
  })
})
