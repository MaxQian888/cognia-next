/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
  useLocale: () => "en",
}))

// jsdom has no layout, so the real virtualizer renders zero rows.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 56,
        size: 56,
        end: (index + 1) * 56,
        lane: 0,
      })),
    getTotalSize: () => count * 56,
    measureElement: jest.fn(),
  }),
}))

const isTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))

const controller = {
  recoverOnStartup: jest.fn(async () => undefined),
  runPreflight: jest.fn(async () => true),
  startRecording: jest.fn(async () => true),
  stopRecording: jest.fn(async () => undefined),
  pauseRecording: jest.fn(async () => undefined),
  resumeRecording: jest.fn(async () => undefined),
  undoLastStep: jest.fn(async () => undefined),
  saveSkill: jest.fn(async () => "skill-1"),
  startControlledTrial: jest.fn(async () => "session-1"),
  confirmTrialAndEnable: jest.fn(async () => undefined),
  generate: jest.fn(async () => true),
  adoptManualDraft: jest.fn(),
  loadAssetBytes: jest.fn(async () => null),
  buildEnvelope: jest.fn(async () => ({
    systemPrompt: "SYSTEM",
    userPrompt: "USER",
    redacted: false,
    truncatedSteps: 0,
    describedSteps: 1,
  })),
}
jest.mock("@/lib/skills/recording/controller", () => ({
  recoverOnStartup: () => controller.recoverOnStartup(),
  runPreflight: () => controller.runPreflight(),
  startRecording: (...a: unknown[]) => controller.startRecording(...(a as [])),
  stopRecording: () => controller.stopRecording(),
  pauseRecording: () => controller.pauseRecording(),
  resumeRecording: () => controller.resumeRecording(),
  undoLastStep: () => controller.undoLastStep(),
  saveSkill: (...a: unknown[]) => controller.saveSkill(...(a as [])),
  startControlledTrial: (...a: unknown[]) => controller.startControlledTrial(...(a as [])),
  confirmTrialAndEnable: (...a: unknown[]) => controller.confirmTrialAndEnable(...(a as [])),
  generate: (...a: unknown[]) => controller.generate(...(a as [])),
  adoptManualDraft: (...a: unknown[]) => controller.adoptManualDraft(...(a as [])),
  loadAssetBytes: (...a: unknown[]) => controller.loadAssetBytes(...(a as [])),
  buildEnvelope: (...a: unknown[]) => controller.buildEnvelope(...(a as [])),
}))

const listCaptureTargets = jest.fn(async () => [
  {
    windowId: 7,
    processId: 8,
    appName: "Safari",
    title: "Invoices",
    focused: true,
    minimized: false,
  },
])
jest.mock("@/lib/skills/recording/recorder-client", () => ({
  recordListCaptureTargets: () => listCaptureTargets(),
}))

jest.mock("@/lib/skills/recording/tool-catalog", () => ({
  ...jest.requireActual("@/lib/skills/recording/tool-catalog"),
  collectRegisteredToolNames: async () => ["Read"],
}))

const registeredShortcuts: { id: string; enabled: boolean; handler: (e: KeyboardEvent) => void }[] =
  []
jest.mock("@/hooks/shortcuts/use-app-shortcut", () => ({
  useAppShortcut: (
    id: string,
    handler: (e: KeyboardEvent) => void,
    options?: { enabled?: boolean }
  ) => {
    registeredShortcuts.push({ id, handler, enabled: options?.enabled !== false })
  },
}))

jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: () => ({ complete: jest.fn() }),
}))

const openSkillInEditor = jest.fn()
jest.mock("@/stores/skills", () => ({
  useSkillsStore: { getState: () => ({ openSkillInEditor }) },
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { defaultProvider: "anthropic", defaultModel: "claude" } }),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  __resetRecorderAvailabilityForTesting,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import type { RecordedStep } from "@/lib/skills/recording/types"

import { SkillRecorderRoot } from "./recorder-root"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"

function store() {
  return useRecorderStore.getState()
}

function step(seq: number): RecordedStep {
  return { seq, tsMs: seq, kind: "click", element: { name: "Export" } }
}

function live() {
  store().dispatch({ type: "OPEN", source: "toolbar" })
  store().dispatch({ type: "PREFLIGHT_START" })
  store().dispatch({ type: "PREFLIGHT_OK" })
  store().dispatch({
    type: "NATIVE_STARTED",
    recordingId: RECORDING,
    startedAt: Date.now(),
    scope: { kind: "desktop" },
    limits: { maxDurationMs: 1, maxSteps: 1, maxBundleBytes: 1, maxGlobalBytes: 1 },
  })
}

/** Reach review with one captured step. */
function reachReview() {
  live()
  store().setCapturedSteps([step(1)])
  store().dispatch({ type: "STOP_REQUESTED" })
  store().dispatch({ type: "STOPPED", steps: [step(1)], ignoredCount: 0, bundleId: RECORDING })
}

/** Reach review and switch the visible stage to Generate. */
function reachGenerate() {
  act(() => {
    reachReview()
    store().setUi({ stageOverride: "generate" })
  })
}

function applyDraft() {
  store().dispatch({ type: "GENERATE_REQUESTED" })
  store().dispatch({
    type: "GENERATED",
    draft: {
      name: "Monthly export",
      description: "",
      content: "## Steps\n1. Go",
      tags: [],
      category: "custom",
      allowedTools: [],
    },
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

/** The last ResizeObserver the Sheet installed, so its callback can be fired. */
let resizeCallback: ((entries: { contentRect: { width: number } }[]) => void) | null = null

class CapturingResizeObserver {
  constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
    resizeCallback = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  jest.clearAllMocks()
  resizeCallback = null
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = CapturingResizeObserver
  registeredShortcuts.length = 0
  isTauri.mockReturnValue(true)
  __resetRecorderAvailabilityForTesting()
  useRecorderStore.getState().reset()
})

describe("mounting", () => {
  it("costs one selector on every route it is not needed", () => {
    const { container } = render(<SkillRecorderRoot />)
    expect(container).toBeEmptyDOMElement()
  })

  it("reconciles with a native session that outlived the reload", () => {
    render(<SkillRecorderRoot />)
    expect(controller.recoverOnStartup).toHaveBeenCalledTimes(1)
  })

  it("does not ask the native side anything in the web shell", () => {
    isTauri.mockReturnValue(false)
    render(<SkillRecorderRoot />)
    expect(controller.recoverOnStartup).not.toHaveBeenCalled()
  })

  it("stays mounted for a session opened while the plugin is unavailable", () => {
    // Recovery can adopt a session the plugin has not published for yet;
    // unmounting would strand it with no surface.
    act(() => {
      store().dispatch({ type: "OPEN", source: "recovery" })
    })
    render(<SkillRecorderRoot />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })
})

describe("the global shortcut", () => {
  it("is registered here, not from the /skills-scoped hook", () => {
    // Three of the four entry points fire on any route; a panel-scoped
    // registration would leave the chord dead everywhere else.
    setRecorderAvailability({ available: true, pluginId: "p" })
    render(<SkillRecorderRoot />)
    expect(registeredShortcuts.map((s) => s.id)).toContain("skills.record")
  })

  it("opens the recorder", () => {
    setRecorderAvailability({ available: true, pluginId: "p" })
    render(<SkillRecorderRoot />)
    const entry = registeredShortcuts.find((s) => s.id === "skills.record")!
    const event = { preventDefault: jest.fn() } as unknown as KeyboardEvent
    act(() => entry.handler(event))
    expect(event.preventDefault).toHaveBeenCalled()
    expect(store().sheetOpen).toBe(true)
  })

  it("is suppressed while the plugin is disabled, so no orphan chord swallows the key", () => {
    render(<SkillRecorderRoot />)
    expect(registeredShortcuts.find((s) => s.id === "skills.record")?.enabled).toBe(false)
  })
})

describe("the Sheet", () => {
  beforeEach(() => {
    setRecorderAvailability({ available: true, pluginId: "p" })
  })

  it("shows the setup stage when opened", async () => {
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
    })
    render(<SkillRecorderRoot />)
    expect(await screen.findByText("setup.scope")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "setup.start" })).toBeInTheDocument()
  })

  it("starts a recording with the chosen scope", async () => {
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
    })
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByText("setup.scopeApplication"))
    // A scoped choice is not startable until a target resolves it.
    await screen.findByText("Safari")
    await userEvent.click(screen.getByRole("button", { name: "setup.start" }))
    expect(controller.startRecording).toHaveBeenCalledWith({
      kind: "application",
      locator: { kind: "displayName", displayName: "Safari" },
    })
  })

  it("starts a window recording with the identity fields the native side needs", async () => {
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
    })
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByText("setup.scopeWindow"))
    await userEvent.click(await screen.findByText("Safari"))
    await userEvent.click(screen.getByRole("button", { name: "setup.start" }))
    expect(controller.startRecording).toHaveBeenCalledWith({
      kind: "window",
      windowId: 7,
      processId: 8,
      appName: "Safari",
      title: "Invoices",
    })
  })

  it("refuses to start a scoped recording with no target, rather than widening to the desktop", async () => {
    listCaptureTargets.mockResolvedValueOnce([])
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
    })
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByText("setup.scopeWindow"))
    await screen.findByText("setup.targetEmpty")

    expect(screen.getByRole("button", { name: "setup.start" })).toBeDisabled()
    expect(screen.getByText("setup.targetRequired")).toBeInTheDocument()
    expect(controller.startRecording).not.toHaveBeenCalled()
  })

  it("dismissing mid-capture hides the panel and never stops the recording", async () => {
    live()
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "close" }))

    expect(store().sheetOpen).toBe(false)
    expect(store().phase).toBe("recording")
    expect(controller.stopRecording).not.toHaveBeenCalled()
  })

  it("dismissing outside a capture tears the session down", async () => {
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
    })
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "close" }))
    expect(store().phase).toBe("idle")
  })

  it("wires the recording controls to the controller", async () => {
    live()
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: /recording\.pause/ }))
    expect(controller.pauseRecording).toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: /recording\.finish/ }))
    expect(controller.stopRecording).toHaveBeenCalled()
  })

  it("wires resume, undo and hide while paused", async () => {
    live()
    act(() => {
      store().appendStep(step(1))
      store().dispatch({ type: "PAUSE" })
    })
    render(<SkillRecorderRoot />)

    await userEvent.click(await screen.findByRole("button", { name: /recording\.resume/ }))
    expect(controller.resumeRecording).toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: /recording\.undo/ }))
    expect(controller.undoLastStep).toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "recording.hideSheet" }))
    expect(store().sheetOpen).toBe(false)
    expect(store().phase).toBe("paused")
  })

  it("retries a blocked preflight without leaving the setup stage", async () => {
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
      store().setPreflight({
        ready: false,
        blockers: ["screenRecordingMissing"],
        platform: "macos",
        platformSupported: true,
        pluginInstalled: true,
        pluginEnabled: true,
        granted: [],
        missingGrants: [],
        automationEnabled: true,
        killSwitchEngaged: false,
        alreadyRecording: false,
        accessibility: "ok",
        inputMonitoring: "ok",
        screenRecording: "missing",
        uiAutomation: "notApplicable",
        ocrBackends: [],
        ocrAvailable: false,
        storage: { usedBytes: 0, globalLimitBytes: 1, bundleLimitBytes: 1 },
        openBundles: 0,
      })
    })
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "preflight.retry" }))
    // Re-checks permissions only. It used to call `startRecording({kind:
    // "desktop"})`, which widened capture past whatever the user had selected
    // on a button whose label promised a permission re-check.
    expect(controller.runPreflight).toHaveBeenCalled()
    expect(controller.startRecording).not.toHaveBeenCalled()
  })

  it("discards an interrupted session when the user chooses to", async () => {
    live()
    act(() => store().dispatch({ type: "INTERRUPT", reason: "permissionLost" }))
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "discard" }))
    expect(store().phase).toBe("idle")
  })

  it("moves on from review to generate without changing the phase", async () => {
    live()
    act(() => {
      store().setCapturedSteps([step(1)])
      store().dispatch({ type: "STOP_REQUESTED" })
      store().dispatch({ type: "STOPPED", steps: [step(1)], ignoredCount: 0, bundleId: RECORDING })
    })
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "review.continue" }))

    await waitFor(() => expect(screen.getByText("generate.previewDescription")).toBeInTheDocument())
    // The stage the user is looking at is not the same thing as what the
    // session is doing.
    expect(store().phase).toBe("review")
  })

  it("measures its own container, so the review split follows the Sheet not the window", async () => {
    // `clamp(420px, 64vw, 960px)` means a wide window can still hold a narrow
    // Sheet; a viewport check would put the split where it does not fit.
    reachGenerate()
    act(() => store().setUi({ stageOverride: "review" }))
    render(<SkillRecorderRoot />)
    await screen.findByRole("listbox")

    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    expect(resizeCallback).not.toBeNull()
    act(() => resizeCallback!([{ contentRect: { width: 900 } }]))
    await waitFor(() =>
      expect(screen.getByRole("separator", { name: "review.splitAria" })).toBeInTheDocument()
    )
  })

  it("steps back to a completed stage from the header", async () => {
    reachReview()
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: /stages\.setup/ }))
    expect(store().stageOverride).toBe("setup")
  })

  it("surfaces an interrupt with its recovery actions", async () => {
    live()
    act(() => store().dispatch({ type: "INTERRUPT", reason: "limitReached" }))
    render(<SkillRecorderRoot />)
    // The banner reads from the `skills.recorder.interrupt` namespace, so its
    // keys arrive bare: `reason.limitReached`, `retry`, `discard`.
    expect(await screen.findByText("reason.limitReached")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "retry" }))
    expect(store().interrupt).toBeNull()
  })
})

describe("generation", () => {
  beforeEach(() => {
    setRecorderAvailability({ available: true, pluginId: "p" })
  })

  it("generates with the configured utility model and locale", async () => {
    reachGenerate()
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: /generate\.run$/ }))

    expect(controller.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "en",
        provider: "anthropic",
        model: "claude",
        asCandidate: false,
      })
    )
  })

  it("regenerates as a candidate, never as an overwrite", async () => {
    reachGenerate()
    act(() => applyDraft())
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "generate.regenerate" }))
    expect(controller.generate).toHaveBeenCalledWith(expect.objectContaining({ asCandidate: true }))
  })

  it("builds a complete template from the timeline when the user asks for it", async () => {
    reachGenerate()
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "generate.manualFallback" }))

    const [draft, locale] = controller.adoptManualDraft.mock.calls[0] as [
      { content: string; allowedTools: string[] },
      string,
    ]
    expect(locale).toBe("en")
    // A complete document, not a stub — and it never claims a tool.
    expect(draft.content).toContain("template.steps")
    expect(draft.allowedTools).toEqual([])
  })

  it("describes every step kind the recorder can capture", async () => {
    act(() => {
      live()
      const steps = [
        step(1),
        {
          seq: 2,
          tsMs: 2,
          kind: "type" as const,
          element: { name: "Search" },
          text: { kind: "text" as const, value: "invoices" },
        },
        {
          seq: 3,
          tsMs: 3,
          kind: "type" as const,
          element: { name: "Password" },
          text: { kind: "sensitive" as const },
        },
        { seq: 4, tsMs: 4, kind: "type" as const, text: { kind: "keys" as const, chord: "cmd+c" } },
        { seq: 5, tsMs: 5, kind: "scroll" as const, scrollDy: -120 },
        { seq: 6, tsMs: 6, kind: "scroll" as const, scrollDy: 120 },
      ]
      store().setCapturedSteps(steps)
      store().dispatch({ type: "STOP_REQUESTED" })
      store().dispatch({ type: "STOPPED", steps, ignoredCount: 0, bundleId: RECORDING })
      store().setUi({ stageOverride: "generate" })
    })
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "generate.manualFallback" }))

    const { content } = controller.adoptManualDraft.mock.calls[0][0] as { content: string }
    expect(content).toContain("template.click")
    expect(content).toContain("template.type")
    // A secret is named, never reconstructed.
    expect(content).toContain("template.secret")
    expect(content).toContain("template.keys")
    expect(content).toContain("template.scrollDown")
    expect(content).toContain("template.scrollUp")
  })

  it("writes a template for a desktop-wide recording with no window to name", async () => {
    // The scope summary is empty for `desktop`; the copy has to survive that
    // rather than interpolating "undefined" into the document.
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
      store().dispatch({ type: "PREFLIGHT_START" })
      store().dispatch({ type: "PREFLIGHT_OK" })
      store().setCapturedSteps([step(1)])
      store().setUi({ stageOverride: "generate" })
    })
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "generate.manualFallback" }))

    const { content } = controller.adoptManualDraft.mock.calls[0][0] as { content: string }
    expect(content).toContain('"scope":""')
  })

  it("honours a per-recording locale override for the template", async () => {
    reachGenerate()
    act(() => store().setOptions({ localeOverride: "zh-CN" }))
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: "generate.manualFallback" }))
    expect(controller.adoptManualDraft.mock.calls[0][1]).toBe("zh-CN")
  })
})

describe("saving and the trial", () => {
  beforeEach(() => {
    setRecorderAvailability({ available: true, pluginId: "p" })
  })

  it("saves the draft", async () => {
    reachGenerate()
    act(() => applyDraft())
    act(() => store().setUi({ stageOverride: "save" }))
    render(<SkillRecorderRoot />)
    await userEvent.click(await screen.findByRole("button", { name: /save\.run/ }))
    await waitFor(() => expect(controller.saveSkill).toHaveBeenCalled())
  })

  it("starts the trial and enables only on an explicit confirmation", async () => {
    reachGenerate()
    act(() => {
      applyDraft()
      store().dispatch({ type: "SAVE_REQUESTED" })
      store().dispatch({ type: "SAVED", skillId: "skill-1" })
      store().setUi({ stageOverride: "save" })
    })
    render(<SkillRecorderRoot />)

    await userEvent.click(await screen.findByRole("button", { name: /save\.trial\.start/ }))
    expect(controller.startControlledTrial).toHaveBeenCalledWith("skill-1")

    act(() => store().dispatch({ type: "TRIAL_STARTED", sessionId: "session-1" }))
    await userEvent.click(screen.getByRole("button", { name: "save.trial.succeeded" }))
    expect(controller.confirmTrialAndEnable).toHaveBeenCalledWith("skill-1")
  })

  it("opens the saved skill in the editor and closes the Sheet behind it", async () => {
    reachGenerate()
    act(() => {
      applyDraft()
      store().dispatch({ type: "SAVE_REQUESTED" })
      store().dispatch({ type: "SAVED", skillId: "skill-1" })
      store().setUi({ stageOverride: "save" })
    })
    render(<SkillRecorderRoot />)

    await userEvent.click(await screen.findByRole("button", { name: "draft.openEditor" }))
    expect(openSkillInEditor).toHaveBeenCalledWith("skill-1", expect.stringContaining("## Steps"))
    expect(store().phase).toBe("idle")
  })
})
