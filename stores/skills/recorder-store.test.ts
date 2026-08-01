import {
  DEFAULT_RECORDER_OPTIONS,
  openRecorder,
  recorderStatusSnapshot,
  useRecorderStore,
} from "./recorder-store"
import type { RecordedStep, RecordPreflight } from "@/lib/skills/recording/types"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"

function step(seq: number, patch: Partial<RecordedStep> = {}): RecordedStep {
  return { seq, tsMs: seq * 100, kind: "click", ...patch }
}

function store() {
  return useRecorderStore.getState()
}

function preflight(patch: Partial<RecordPreflight> = {}): RecordPreflight {
  return {
    ready: true,
    blockers: [],
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
    screenRecording: "ok",
    uiAutomation: "notApplicable",
    ocrBackends: ["apple-vision"],
    ocrAvailable: true,
    storage: { usedBytes: 0, globalLimitBytes: 1, bundleLimitBytes: 1 },
    openBundles: 0,
    ...patch,
  }
}

/** Drive the store into a live recording, the way the controller does. */
function startRecording() {
  store().dispatch({ type: "OPEN", source: "toolbar" })
  store().dispatch({ type: "PREFLIGHT_START" })
  store().dispatch({ type: "PREFLIGHT_OK" })
  store().dispatch({
    type: "NATIVE_STARTED",
    recordingId: RECORDING,
    startedAt: 1000,
    scope: { kind: "desktop" },
    limits: {
      maxDurationMs: 3_600_000,
      maxSteps: 500,
      maxBundleBytes: 262_144_000,
      maxGlobalBytes: 2_147_483_648,
    },
  })
}

beforeEach(() => {
  useRecorderStore.getState().reset()
})

describe("dispatch", () => {
  it("applies a legal transition and reports success", () => {
    expect(store().dispatch({ type: "OPEN", source: "palette" })).toBe(true)
    expect(store().phase).toBe("setup")
  })

  it("refuses an illegal transition without throwing", () => {
    // A stray native event arriving a beat late must not take the app down.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    expect(store().dispatch({ type: "SAVED", skillId: "s1" })).toBe(false)
    expect(store().phase).toBe("idle")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignored SAVED"))
    warn.mockRestore()
  })

  it("raises the Sheet on OPEN and lowers it on CLOSE", () => {
    store().dispatch({ type: "OPEN", source: "shortcut" })
    expect(store().sheetOpen).toBe(true)
    store().dispatch({ type: "CLOSE" })
    expect(store().sheetOpen).toBe(false)
  })

  it("reattaches instead of duplicating when OPEN arrives mid-recording", () => {
    // The single-live-session invariant: a second entry point raises the Sheet
    // on the running session, it never starts a second one. Dismissing the Sheet
    // mid-capture is `setUi`, not `CLOSE` — the recording keeps running behind
    // the floating controller.
    startRecording()
    store().setUi({ sheetOpen: false })

    expect(store().dispatch({ type: "OPEN", source: "slash-command" })).toBe(true)
    expect(store().sheetOpen).toBe(true)
    expect(store().phase).toBe("recording")
    expect(store().recordingId).toBe(RECORDING)
  })

  it("CLOSE is the explicit discard — it tears the session down", () => {
    startRecording()
    store().dispatch({ type: "CLOSE" })
    expect(store().phase).toBe("idle")
    expect(store().recordingId).toBeNull()
    expect(store().sheetOpen).toBe(false)
  })

  it("leaves the Sheet alone for events that are not OPEN or CLOSE", () => {
    startRecording()
    store().setUi({ sheetOpen: false })
    store().dispatch({ type: "PAUSE" })
    expect(store().sheetOpen).toBe(false)
    expect(store().phase).toBe("paused")
  })
})

describe("captured steps and derived views", () => {
  it("derives a view per captured step", () => {
    store().setCapturedSteps([step(1), step(2)])
    expect(store().steps.map((v) => v.seq)).toEqual([1, 2])
    expect(store().capturedSteps).toHaveLength(2)
  })

  it("appends without re-deriving from scratch losing order", () => {
    store().setCapturedSteps([step(1)])
    store().appendStep(step(2))
    expect(store().steps.map((v) => v.seq)).toEqual([1, 2])
  })

  it("drops the undone step by seq", () => {
    store().setCapturedSteps([step(1), step(2), step(3)])
    store().dropStep(2)
    expect(store().steps.map((v) => v.seq)).toEqual([1, 3])
  })

  it("ignores a drop for a seq that is not there", () => {
    store().setCapturedSteps([step(1)])
    store().dropStep(99)
    expect(store().capturedSteps).toHaveLength(1)
  })

  it("re-applies edits over the same capture", () => {
    store().setCapturedSteps([step(1), step(2)])
    store().setEdits({ bySeq: { 1: { excluded: true } }, manual: [] })
    expect(store().steps.find((v) => v.seq === 1)?.excluded).toBe(true)
    // The capture itself is untouched — edits are replayed, never destructive.
    expect(store().capturedSteps.map((s) => s.seq)).toEqual([1, 2])
  })

  it("keeps edits when new steps arrive", () => {
    store().setEdits({ bySeq: { 1: { intent: "Open billing" } }, manual: [] })
    store().appendStep(step(1))
    expect(store().steps[0].intent).toBe("Open billing")
  })

  it("surfaces a manual step from the edits", () => {
    store().setEdits({
      bySeq: {},
      manual: [{ seq: -1, afterSeq: 0, intent: "Log in first" }],
    })
    expect(store().steps.map((v) => v.manual)).toEqual([true])
  })
})

describe("ui and options", () => {
  it("patches ui state without clobbering the rest", () => {
    store().setUi({ splitPercent: 60 })
    store().setUi({ detailView: "detail" })
    expect(store().splitPercent).toBe(60)
    expect(store().detailView).toBe("detail")
  })

  it("starts at the 42/58 split", () => {
    expect(store().splitPercent).toBe(42)
  })

  it("patches options without clobbering the rest", () => {
    store().setOptions({ captureScreenshots: false })
    store().setOptions({ localeOverride: "zh-CN" })
    expect(store().options).toEqual({
      ...DEFAULT_RECORDER_OPTIONS,
      captureScreenshots: false,
      localeOverride: "zh-CN",
    })
  })

  it("defaults to capturing screenshots with no model or locale override", () => {
    expect(DEFAULT_RECORDER_OPTIONS).toEqual({
      captureScreenshots: true,
      modelOverride: null,
      localeOverride: null,
    })
  })

  it("holds the preflight result and can clear it", () => {
    store().setPreflight(preflight({ ready: false, blockers: ["pluginDisabled"] }))
    expect(store().preflight?.blockers).toEqual(["pluginDisabled"])
    store().setPreflight(null)
    expect(store().preflight).toBeNull()
  })

  it("tracks tool confirmation", () => {
    expect(store().toolsConfirmed).toBe(false)
    store().setToolsConfirmed(true)
    expect(store().toolsConfirmed).toBe(true)
  })
})

describe("reset", () => {
  it("clears capture, edits, options and ui together", () => {
    startRecording()
    store().setCapturedSteps([step(1)])
    store().setEdits({ bySeq: { 1: { excluded: true } }, manual: [] })
    store().setOptions({ captureScreenshots: false })
    store().setToolsConfirmed(true)
    store().setPreflight(preflight())

    store().reset()

    expect(store().phase).toBe("idle")
    expect(store().recordingId).toBeNull()
    expect(store().capturedSteps).toEqual([])
    expect(store().steps).toEqual([])
    expect(store().edits).toEqual({ bySeq: {}, manual: [] })
    expect(store().options).toEqual(DEFAULT_RECORDER_OPTIONS)
    expect(store().preflight).toBeNull()
    expect(store().toolsConfirmed).toBe(false)
    expect(store().sheetOpen).toBe(false)
    expect(store().splitPercent).toBe(42)
  })
})

describe("openRecorder", () => {
  it("is the imperative entry point for non-React callers", () => {
    openRecorder("slash-command")
    expect(store().phase).toBe("setup")
    expect(store().sheetOpen).toBe(true)
  })

  it("reattaches rather than restarting when one is already running", () => {
    startRecording()
    openRecorder("palette")
    expect(store().phase).toBe("recording")
    expect(store().recordingId).toBe(RECORDING)
  })
})

describe("recorderStatusSnapshot", () => {
  it("reports nothing running when idle", () => {
    expect(recorderStatusSnapshot()).toEqual({ recording: false, phase: "idle", stepCount: 0 })
  })

  it("reports a live recording with its step count", () => {
    startRecording()
    store().appendStep(step(1))
    store().appendStep(step(2))
    expect(recorderStatusSnapshot()).toEqual({ recording: true, phase: "recording", stepCount: 2 })
  })

  it("counts a paused recording as still running", () => {
    // Paused holds the input hook and the bundle open; reporting it as stopped
    // would let the agent tool tell the user they are free to start another.
    startRecording()
    store().dispatch({ type: "PAUSE" })
    expect(recorderStatusSnapshot()).toMatchObject({ recording: true, phase: "paused" })
  })

  it("reports review as not recording", () => {
    startRecording()
    store().dispatch({ type: "STOP_REQUESTED" })
    store().dispatch({ type: "STOPPED", steps: [step(1)], ignoredCount: 0, bundleId: RECORDING })
    expect(recorderStatusSnapshot()).toMatchObject({ recording: false, phase: "review" })
  })
})
