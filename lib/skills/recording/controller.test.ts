/**
 * The controller is driven directly and awaited, never through a React effect —
 * which is the whole point of splitting it out of the store.
 */

const nativeHandlers: ((event: Record<string, unknown>) => void)[] = []

const client = {
  onRecordEvent: jest.fn((handler: (event: Record<string, unknown>) => void) => {
    nativeHandlers.push(handler)
    return jest.fn(() => {
      const index = nativeHandlers.indexOf(handler)
      if (index >= 0) nativeHandlers.splice(index, 1)
    })
  }),
  recordPreflight: jest.fn(),
  recordStart: jest.fn(),
  recordPause: jest.fn(),
  recordResume: jest.fn(),
  recordUndoLast: jest.fn(),
  recordStop: jest.fn(),
  recordStatus: jest.fn(),
  recordListRecoverable: jest.fn(),
  recordLoadBundle: jest.fn(),
  recordReadAsset: jest.fn(),
}

const dbRecordings = {
  createRecording: jest.fn(async () => undefined),
  checkpointRecording: jest.fn(async () => undefined),
  getRecording: jest.fn(async () => undefined),
  listUnfinishedRecordings: jest.fn(async () => []),
  setRecordingStatus: jest.fn(async () => undefined),
}

const saveRecordedSkill = jest.fn(async (_input: unknown) => ({ skillId: "skill-1" }))
const collectRegisteredToolNames = jest.fn(async () => ["Read", "Bash"])
const toastError = jest.fn()

// The factories are hoisted above the consts above, so every reference has to
// be made lazily — inside a function body, never in the returned literal.
jest.mock("./recorder-client", () => ({
  RECORD_EVENT_CHANNEL: "record:event",
  onRecordEvent: (...a: unknown[]) => client.onRecordEvent(...(a as [never])),
  recordPreflight: (...a: unknown[]) => client.recordPreflight(...(a as [])),
  recordStart: (...a: unknown[]) => client.recordStart(...(a as [])),
  recordPause: (...a: unknown[]) => client.recordPause(...(a as [])),
  recordResume: (...a: unknown[]) => client.recordResume(...(a as [])),
  recordUndoLast: (...a: unknown[]) => client.recordUndoLast(...(a as [])),
  recordStop: (...a: unknown[]) => client.recordStop(...(a as [])),
  recordStatus: (...a: unknown[]) => client.recordStatus(...(a as [])),
  recordListRecoverable: (...a: unknown[]) => client.recordListRecoverable(...(a as [])),
  recordLoadBundle: (...a: unknown[]) => client.recordLoadBundle(...(a as [])),
  recordReadAsset: (...a: unknown[]) => client.recordReadAsset(...(a as [])),
}))
jest.mock("@/lib/db/skill-recordings", () => ({
  createRecording: (...a: unknown[]) => dbRecordings.createRecording(...(a as [])),
  checkpointRecording: (...a: unknown[]) => dbRecordings.checkpointRecording(...(a as [])),
  getRecording: (...a: unknown[]) => dbRecordings.getRecording(...(a as [])),
  listUnfinishedRecordings: (...a: unknown[]) =>
    dbRecordings.listUnfinishedRecordings(...(a as [])),
  setRecordingStatus: (...a: unknown[]) => dbRecordings.setRecordingStatus(...(a as [])),
}))
jest.mock("./persist-recorded-skill", () => ({
  saveRecordedSkill: (...args: unknown[]) => saveRecordedSkill(...(args as [unknown])),
}))
jest.mock("./tool-catalog", () => ({
  ...jest.requireActual("./tool-catalog"),
  collectRegisteredToolNames: () => collectRegisteredToolNames(),
}))
jest.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

const createSession = jest.fn(async (_input: unknown) => ({ id: "session-1" }))
jest.mock("@/lib/db/sessions", () => ({
  createSession: (...a: unknown[]) => createSession(...(a as [unknown])),
}))

const enabledSkillIds = { value: [] as string[] }
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    skills: {
      where: () => ({ equals: () => ({ primaryKeys: async () => enabledSkillIds.value }) }),
    },
  }),
}))

const setSkillStatus = jest.fn(async () => undefined)
jest.mock("@/lib/db/skills", () => ({
  setSkillStatus: (...a: unknown[]) => setSkillStatus(...(a as [])),
}))

import { useRecorderStore } from "@/stores/skills/recorder-store"

import {
  __resetControllerForTesting,
  attachNativeEvents,
  buildEnvelope,
  confirmTrialAndEnable,
  startControlledTrial,
  detachNativeEvents,
  generate,
  hashPrompt,
  loadAssetBytes,
  pauseRecording,
  recoverOnStartup,
  resumeRecording,
  runPreflight,
  saveSkill,
  startRecording,
  stopRecording,
  undoLastStep,
  adoptManualDraft,
} from "./controller"
import type {
  BundleManifest,
  CaptureScope,
  RecordedStep,
  RecordingBundle,
  RecordLimits,
  RecordPreflight,
} from "./types"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"
const SCOPE: CaptureScope = { kind: "desktop" }
const LIMITS: RecordLimits = {
  maxDurationMs: 3_600_000,
  maxSteps: 500,
  maxBundleBytes: 262_144_000,
  maxGlobalBytes: 2_147_483_648,
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
    granted: ["native:input", "native:screen", "media:image:write"],
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

function step(seq: number, patch: Partial<RecordedStep> = {}): RecordedStep {
  return { seq, tsMs: seq * 100, kind: "click", element: { name: `Button ${seq}` }, ...patch }
}

function manifest(): BundleManifest {
  return {
    schemaVersion: 1,
    recordingId: RECORDING,
    startedAt: 1000,
    scope: SCOPE,
    captureScreenshots: true,
    limits: LIMITS,
    monitors: [],
    appVersion: "0.1.0",
    platform: "macos",
  }
}

function bundle(patch: Partial<RecordingBundle> = {}): RecordingBundle {
  return {
    manifest: manifest(),
    steps: [step(1), step(2)],
    outcome: "completed",
    ignoredCount: 3,
    totalBytes: 4096,
    ...patch,
  }
}

/** Put the store into a live recording without going through the native call. */
function live() {
  store().dispatch({ type: "OPEN", source: "toolbar" })
  store().dispatch({ type: "PREFLIGHT_START" })
  store().dispatch({ type: "PREFLIGHT_OK" })
  store().dispatch({
    type: "NATIVE_STARTED",
    recordingId: RECORDING,
    startedAt: 1000,
    scope: SCOPE,
    limits: manifest().limits,
  })
}

function emit(event: Record<string, unknown>) {
  for (const handler of [...nativeHandlers]) handler(event)
}

beforeEach(() => {
  jest.clearAllMocks()
  nativeHandlers.length = 0
  __resetControllerForTesting()
  useRecorderStore.getState().reset()
  client.recordPreflight.mockResolvedValue(preflight())
  client.recordStart.mockResolvedValue(undefined)
  client.recordStop.mockResolvedValue(bundle())
  client.recordLoadBundle.mockResolvedValue(bundle())
  client.recordStatus.mockResolvedValue({ recording: false, stepCount: 0, usage: [] })
  client.recordListRecoverable.mockResolvedValue([])
  collectRegisteredToolNames.mockResolvedValue(["Read", "Bash"])
  // `clearAllMocks` clears calls but keeps implementations, so every default
  // has to be restated or one test's rows leak into the next one's recovery.
  dbRecordings.createRecording.mockResolvedValue(undefined)
  dbRecordings.checkpointRecording.mockResolvedValue(undefined)
  dbRecordings.setRecordingStatus.mockResolvedValue(undefined)
  dbRecordings.getRecording.mockResolvedValue(undefined)
  dbRecordings.listUnfinishedRecordings.mockResolvedValue([])
  saveRecordedSkill.mockResolvedValue({ skillId: "skill-1" })
  createSession.mockResolvedValue({ id: "session-1" })
  setSkillStatus.mockResolvedValue(undefined)
  enabledSkillIds.value = []
})

afterEach(() => {
  __resetControllerForTesting()
})

describe("runPreflight", () => {
  it("stores the report and advances when ready", async () => {
    store().dispatch({ type: "OPEN", source: "toolbar" })
    await expect(runPreflight()).resolves.toBe(true)
    expect(store().preflight?.ready).toBe(true)
    expect(store().phase).toBe("preflight")
  })

  it("reports the first blocker as the error code", async () => {
    // The order `preflight.rs` emits is the security contract; the first entry
    // is the one that actually stopped the recording.
    client.recordPreflight.mockResolvedValue(
      preflight({ ready: false, blockers: ["killSwitchEngaged", "grantMissing:native:screen"] })
    )
    store().dispatch({ type: "OPEN", source: "toolbar" })
    await expect(runPreflight()).resolves.toBe(false)
    expect(store().error?.code).toBe("killSwitchEngaged")
    expect(store().phase).toBe("setup")
  })

  it("survives a native failure and clears the stale report", async () => {
    client.recordPreflight.mockRejectedValue(new Error("ipc down"))
    store().dispatch({ type: "OPEN", source: "toolbar" })
    await expect(runPreflight()).resolves.toBe(false)
    expect(store().preflight).toBeNull()
    expect(store().error).toMatchObject({ code: "preflightFailed", detail: "ipc down" })
  })

  it("refuses to run from a phase that has no preflight", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await expect(runPreflight()).resolves.toBe(false)
    expect(client.recordPreflight).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("startRecording", () => {
  it("mints the id, subscribes before starting, and passes the id to native", async () => {
    store().dispatch({ type: "OPEN", source: "toolbar" })
    await expect(startRecording(SCOPE)).resolves.toBe(true)

    // Subscribing after `record_start` would miss the first few hundred ms —
    // exactly when the user is checking that recording works.
    expect(client.onRecordEvent).toHaveBeenCalled()
    const [args] = client.recordStart.mock.calls[0] as [
      { recordingId: string; scope: CaptureScope; captureScreenshots: boolean },
    ]
    expect(args.scope).toEqual(SCOPE)
    expect(args.captureScreenshots).toBe(true)
    // One identity shared by the Dexie row and the bundle directory.
    expect(dbRecordings.createRecording).toHaveBeenCalledWith({ id: args.recordingId })
  })

  it("passes the user's screenshot choice through", async () => {
    store().dispatch({ type: "OPEN", source: "toolbar" })
    store().setOptions({ captureScreenshots: false })
    await startRecording(SCOPE)
    expect(client.recordStart.mock.calls[0][0]).toMatchObject({ captureScreenshots: false })
  })

  it("does not call native at all when preflight fails", async () => {
    client.recordPreflight.mockResolvedValue(
      preflight({ ready: false, blockers: ["pluginDisabled"] })
    )
    store().dispatch({ type: "OPEN", source: "toolbar" })
    await expect(startRecording(SCOPE)).resolves.toBe(false)
    expect(client.recordStart).not.toHaveBeenCalled()
    expect(dbRecordings.createRecording).not.toHaveBeenCalled()
  })

  it("discards the row when the native start is rejected", async () => {
    // The gate rejecting is the expected path, not an anomaly — a row left
    // behind would show up in recovery as work the user never did.
    client.recordStart.mockRejectedValue(new Error("kill switch is active"))
    store().dispatch({ type: "OPEN", source: "toolbar" })
    await expect(startRecording(SCOPE)).resolves.toBe(false)
    expect(dbRecordings.setRecordingStatus).toHaveBeenCalledWith(expect.any(String), "discarded")
    expect(store().error).toMatchObject({ code: "startFailed", detail: "kill switch is active" })
  })
})

describe("native events", () => {
  it("subscribes once however many times it is attached", () => {
    attachNativeEvents()
    attachNativeEvents()
    expect(client.onRecordEvent).toHaveBeenCalledTimes(1)
  })

  it("re-subscribes after a detach", () => {
    attachNativeEvents()
    detachNativeEvents()
    attachNativeEvents()
    expect(client.onRecordEvent).toHaveBeenCalledTimes(2)
  })

  it("adopts the native session identity on `started`", () => {
    store().dispatch({ type: "OPEN", source: "toolbar" })
    store().dispatch({ type: "PREFLIGHT_START" })
    store().dispatch({ type: "PREFLIGHT_OK" })
    attachNativeEvents()
    emit({
      type: "started",
      recordingId: RECORDING,
      startedAt: 1000,
      scope: SCOPE,
      limits: manifest().limits,
    })
    expect(store().phase).toBe("recording")
    expect(store().recordingId).toBe(RECORDING)
  })

  it("appends each step to the capture", () => {
    live()
    attachNativeEvents()
    emit({ type: "step", step: step(1) })
    emit({ type: "step", step: step(2) })
    expect(store().capturedSteps.map((s) => s.seq)).toEqual([1, 2])
    expect(store().steps).toHaveLength(2)
  })

  it("mirrors pause and resume", () => {
    live()
    attachNativeEvents()
    emit({ type: "paused" })
    expect(store().phase).toBe("paused")
    emit({ type: "resumed" })
    expect(store().phase).toBe("recording")
  })

  it("removes the tombstoned step on `undone`", () => {
    live()
    attachNativeEvents()
    emit({ type: "step", step: step(1) })
    emit({ type: "step", step: step(2) })
    emit({ type: "undone", seq: 2 })
    expect(store().capturedSteps.map((s) => s.seq)).toEqual([1])
  })

  it("surfaces a limit warning as usage", () => {
    live()
    attachNativeEvents()
    const usage = { kind: "steps" as const, used: 400, limit: 500, warned: true }
    emit({ type: "limitWarning", usage })
    expect(store().usage).toEqual([usage])
  })

  it("reads the bundle rather than trusting the accumulated list on `stopped`", async () => {
    // The renderer's list can be short by whatever the last flush had buffered.
    live()
    attachNativeEvents()
    emit({ type: "step", step: step(1) })
    emit({ type: "stopped", recordingId: RECORDING })
    await Promise.resolve()
    await Promise.resolve()
    expect(client.recordLoadBundle).toHaveBeenCalledWith(RECORDING)
    expect(store().capturedSteps).toHaveLength(2)
    expect(store().ignoredCount).toBe(3)
  })

  it("records an interrupt against the row", async () => {
    live()
    attachNativeEvents()
    emit({ type: "interrupted", recordingId: RECORDING, reason: "killSwitch" })
    await Promise.resolve()
    expect(store().phase).toBe("interrupted")
    expect(store().interrupt).toMatchObject({ reason: "killSwitch", retriable: false })
    expect(dbRecordings.checkpointRecording).toHaveBeenCalledWith(
      RECORDING,
      expect.objectContaining({ status: "interrupted" })
    )
  })

  it("reports an arming failure as a preflight blocker", () => {
    store().dispatch({ type: "OPEN", source: "toolbar" })
    store().dispatch({ type: "PREFLIGHT_START" })
    attachNativeEvents()
    emit({ type: "error", message: "hook install failed" })
    expect(store().error).toMatchObject({ code: "nativeError", detail: "hook install failed" })
    expect(store().phase).toBe("setup")
  })

  it("interrupts on a mid-capture failure so the journal survives", () => {
    live()
    attachNativeEvents()
    emit({ type: "error", message: "input hook died" })
    expect(store().phase).toBe("interrupted")
    expect(store().interrupt).toMatchObject({ reason: "nativeFailure", retriable: true })
    expect(toastError).toHaveBeenCalledWith("input hook died")
  })

  it("never throws away review work for a late native complaint", async () => {
    live()
    await stopRecording()
    attachNativeEvents()
    emit({ type: "error", message: "asset write failed" })
    expect(store().phase).toBe("review")
    expect(store().capturedSteps).toHaveLength(2)
    expect(toastError).toHaveBeenCalledWith("asset write failed")
  })
})

describe("transport wrappers", () => {
  it("swallow a native rejection — the event channel is the source of truth", async () => {
    client.recordPause.mockRejectedValue(new Error("no session"))
    client.recordResume.mockRejectedValue(new Error("no session"))
    client.recordUndoLast.mockRejectedValue(new Error("no session"))
    await expect(pauseRecording()).resolves.toBeUndefined()
    await expect(resumeRecording()).resolves.toBeUndefined()
    await expect(undoLastStep()).resolves.toBeUndefined()
  })
})

describe("stopRecording", () => {
  it("applies the bundle and derives variable suggestions", async () => {
    live()
    await stopRecording()
    expect(store().phase).toBe("review")
    expect(store().capturedSteps).toHaveLength(2)
    expect(store().bundleId).toBe(RECORDING)
    expect(dbRecordings.checkpointRecording).toHaveBeenCalledWith(
      RECORDING,
      expect.objectContaining({ status: "captured", bundleId: RECORDING, bundleBytes: 4096 })
    )
  })

  it("derives variable suggestions, every one of them unconfirmed", async () => {
    // Nothing becomes a placeholder without the user saying so — a silently
    // confirmed suggestion would put recorded text into the skill body.
    live()
    client.recordStop.mockResolvedValue(
      bundle({
        steps: [
          step(1, {
            kind: "type",
            element: { name: "Order" },
            text: { kind: "text", value: "ORD-42" },
          }),
        ],
      })
    )
    await stopRecording()
    expect(store().inputVariables).toEqual([
      expect.objectContaining({ seq: 1, kind: "variable", confirmed: false }),
    ])
  })

  it("interrupts and surfaces the failure when the stop itself fails", async () => {
    live()
    client.recordStop.mockRejectedValue(new Error("drain timed out"))
    await stopRecording()
    expect(store().phase).toBe("interrupted")
    expect(toastError).toHaveBeenCalledWith("drain timed out")
  })

  it("does nothing when no capture is live", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await stopRecording()
    expect(client.recordStop).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("falls back to an interrupt when the bundle cannot be read after `stopped`", async () => {
    live()
    attachNativeEvents()
    client.recordLoadBundle.mockRejectedValue(new Error("gone"))
    emit({ type: "stopped", recordingId: RECORDING })
    await Promise.resolve()
    await Promise.resolve()
    expect(store().phase).toBe("interrupted")
  })
})

describe("loadAssetBytes", () => {
  it("fetches once and serves the rest from the cache", async () => {
    live()
    await stopRecording()
    client.recordReadAsset.mockResolvedValue({ assetId: "a", mimeType: "image/png", bytes: "AAAA" })
    await expect(loadAssetBytes("a")).resolves.toBe("AAAA")
    await expect(loadAssetBytes("a")).resolves.toBe("AAAA")
    expect(client.recordReadAsset).toHaveBeenCalledTimes(1)
  })

  it("returns null with no bundle to read from", async () => {
    await expect(loadAssetBytes("a")).resolves.toBeNull()
    expect(client.recordReadAsset).not.toHaveBeenCalled()
  })

  it("returns null rather than throwing when the frame is unreadable", async () => {
    live()
    await stopRecording()
    client.recordReadAsset.mockRejectedValue(new Error("missing"))
    await expect(loadAssetBytes("a")).resolves.toBeNull()
  })
})

describe("generate", () => {
  async function reachReview() {
    live()
    await stopRecording()
  }

  it("sends the envelope the preview was built from, byte for byte", async () => {
    await reachReview()
    const previewed = await buildEnvelope("en")
    const complete = jest.fn(async () =>
      JSON.stringify({ name: "Export", content: "## Steps\n1. Go", allowedTools: ["Read"] })
    )
    await expect(
      generate({
        locale: "en",
        client: { complete },
        provider: "anthropic",
        model: "claude",
        fallbackName: "fb",
      })
    ).resolves.toBe(true)

    expect(complete).toHaveBeenCalledWith(
      previewed.userPrompt,
      expect.objectContaining({ system: previewed.systemPrompt })
    )
    expect(store().draft?.name).toBe("Export")
    expect(store().generation).toMatchObject({
      provider: "anthropic",
      model: "claude",
      promptHash: hashPrompt(previewed.userPrompt),
    })
  })

  it("fails closed with `noModel` when nothing is configured", async () => {
    await reachReview()
    await expect(
      generate({ locale: "en", client: null, provider: "", model: "", fallbackName: "fb" })
    ).resolves.toBe(false)
    // Non-retriable: retrying without a model would fail identically.
    expect(store().error).toMatchObject({ code: "noModel", retriable: false })
  })

  it("returns to review on a model failure so the manual path stays reachable", async () => {
    await reachReview()
    await expect(
      generate({
        locale: "en",
        client: { complete: jest.fn(async () => "not json") },
        provider: "p",
        model: "m",
        fallbackName: "fb",
      })
    ).resolves.toBe(false)
    expect(store().phase).toBe("review")
    expect(store().error?.code).toBe("generationFailed")
  })

  it("keeps a regeneration as a candidate rather than overwriting the draft", async () => {
    await reachReview()
    const complete = jest.fn(async () =>
      JSON.stringify({ name: "First", content: "## Steps\n1. One" })
    )
    await generate({
      locale: "en",
      client: { complete },
      provider: "p",
      model: "m",
      fallbackName: "fb",
    })
    complete.mockResolvedValue(JSON.stringify({ name: "Second", content: "## Steps\n1. Two" }))
    await generate({
      locale: "en",
      client: { complete },
      provider: "p",
      model: "m",
      fallbackName: "fb",
      asCandidate: true,
    })
    expect(store().draft?.name).toBe("First")
    expect(store().candidateDraft?.name).toBe("Second")
  })

  it("requires tools to be re-confirmed after every generation", async () => {
    await reachReview()
    store().setToolsConfirmed(true)
    await generate({
      locale: "en",
      client: { complete: jest.fn(async () => JSON.stringify({ content: "## Steps\n1. Go" })) },
      provider: "p",
      model: "m",
      fallbackName: "fb",
    })
    expect(store().toolsConfirmed).toBe(false)
  })

  it("honours the per-recording locale override", async () => {
    await reachReview()
    store().setOptions({ localeOverride: "zh-CN" })
    await generate({
      locale: "en",
      client: { complete: jest.fn(async () => JSON.stringify({ content: "## Steps\n1. Go" })) },
      provider: "p",
      model: "m",
      fallbackName: "fb",
    })
    expect(store().generation?.locale).toBe("zh-CN")
  })
})

describe("adoptManualDraft", () => {
  it("adopts a template draft with honest provenance", async () => {
    live()
    await stopRecording()
    adoptManualDraft(
      {
        name: "Manual",
        description: "",
        content: "## Steps\n1. Go",
        tags: [],
        category: "custom",
        allowedTools: [],
      },
      "en"
    )
    expect(store().phase).toBe("draft")
    // `provider: "none"` is what tells the versions tab no model was involved.
    expect(store().generation).toMatchObject({
      provider: "none",
      model: "manual-template",
      redacted: false,
      promptHash: "",
    })
  })
})

describe("hashPrompt", () => {
  it("is stable and distinguishes different payloads", () => {
    expect(hashPrompt("abc")).toBe(hashPrompt("abc"))
    expect(hashPrompt("abc")).not.toBe(hashPrompt("abd"))
  })

  it("handles an empty payload", () => {
    expect(hashPrompt("")).toBe("0")
  })
})

describe("saveSkill", () => {
  async function reachDraft() {
    live()
    await stopRecording()
    adoptManualDraft(
      {
        name: "Manual",
        description: "",
        content: "## Steps\n1. Go",
        tags: [],
        category: "custom",
        allowedTools: [],
      },
      "en"
    )
  }

  it("saves through the atomic persist module and records the skill id", async () => {
    await reachDraft()
    await expect(saveSkill(() => "alt")).resolves.toBe("skill-1")
    expect(store().phase).toBe("saved")
    expect(store().savedSkillId).toBe("skill-1")
    expect(saveRecordedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: RECORDING, bundleId: RECORDING })
    )
  })

  it("refuses without a draft", async () => {
    live()
    await stopRecording()
    await expect(saveSkill(() => "alt")).resolves.toBeNull()
    expect(saveRecordedSkill).not.toHaveBeenCalled()
  })

  it("skips a frame it could not read rather than writing it empty", async () => {
    // An `<img>` pointing at a zero-byte resource is worse than no image.
    live()
    client.recordStop.mockResolvedValue(
      bundle({ steps: [step(1, { assetId: "asset-1" }), step(2, { assetId: "asset-2" })] })
    )
    await stopRecording()
    adoptManualDraft(
      {
        name: "Manual",
        description: "",
        content: "## Steps\n1. Go\n2. Go",
        tags: [],
        category: "custom",
        allowedTools: [],
      },
      "en"
    )
    client.recordReadAsset.mockImplementation(async (_id: string, assetId: string) =>
      assetId === "asset-1" ? { assetId, mimeType: "image/png", bytes: "AAAA" } : null
    )

    await saveSkill(() => "alt")
    const [input] = saveRecordedSkill.mock.calls[0] as [{ resources: { path: string }[] }]
    expect(input.resources.map((r) => r.path)).toEqual(["assets/recording-step-001.png"])
  })

  it("returns to draft on failure — the transaction rolled back, nothing is lost", async () => {
    await reachDraft()
    saveRecordedSkill.mockRejectedValueOnce(new Error("quota exceeded"))
    await expect(saveSkill(() => "alt")).resolves.toBeNull()
    expect(store().phase).toBe("draft")
    expect(store().error).toMatchObject({ code: "saveFailed", detail: "quota exceeded" })
    expect(store().draft?.name).toBe("Manual")
  })
})

describe("recoverOnStartup", () => {
  it("does nothing when the native side cannot be reached", async () => {
    client.recordStatus.mockRejectedValue(new Error("no backend"))
    await recoverOnStartup()
    expect(store().phase).toBe("idle")
  })

  it("does nothing when there is nothing to reconcile", async () => {
    await recoverOnStartup()
    expect(store().phase).toBe("idle")
    expect(client.onRecordEvent).not.toHaveBeenCalled()
  })

  it("reattaches to a live session and restores its edits", async () => {
    client.recordStatus.mockResolvedValue({
      recording: true,
      recordingId: RECORDING,
      phase: "recording",
      stepCount: 2,
      startedAt: 1000,
      scope: SCOPE,
      usage: [],
    })
    dbRecordings.listUnfinishedRecordings.mockResolvedValue([
      { id: RECORDING, status: "recording", updatedAt: 1 },
    ] as never)
    dbRecordings.getRecording.mockResolvedValue({
      id: RECORDING,
      edits: { bySeq: { 1: { intent: "Open billing" } }, manual: [] },
      inputVariables: [{ name: "orderId", kind: "variable", seq: 1, confirmed: true }],
    } as never)

    await recoverOnStartup()

    expect(store().phase).toBe("recording")
    expect(store().recordingId).toBe(RECORDING)
    expect(store().edits.bySeq[1]).toEqual({ intent: "Open billing" })
    expect(store().inputVariables).toHaveLength(1)
    // Reattaching without resubscribing would leave the session unobservable.
    expect(client.onRecordEvent).toHaveBeenCalled()
  })

  it("reflects a paused native session as paused", async () => {
    client.recordStatus.mockResolvedValue({
      recording: true,
      recordingId: RECORDING,
      phase: "paused",
      stepCount: 0,
      usage: [],
    })
    await recoverOnStartup()
    expect(store().phase).toBe("paused")
  })

  it("creates a row for a live session it has never seen", async () => {
    client.recordStatus.mockResolvedValue({
      recording: true,
      recordingId: RECORDING,
      stepCount: 0,
      usage: [],
    })
    await recoverOnStartup()
    expect(dbRecordings.createRecording).toHaveBeenCalledWith({
      id: RECORDING,
      status: "recording",
    })
  })

  it("loads a stranded bundle into review rather than resuming it", async () => {
    // Silently rejoining a recording the user thought had ended would be worse
    // than asking; the bundle is loaded, the capture is not restarted.
    dbRecordings.listUnfinishedRecordings.mockResolvedValue([
      { id: RECORDING, status: "captured", updatedAt: 1 },
    ] as never)
    dbRecordings.getRecording.mockResolvedValue({
      id: RECORDING,
      draft: {
        name: "Prior",
        description: "",
        content: "x",
        tags: [],
        category: "custom",
        allowedTools: [],
      },
    } as never)

    await recoverOnStartup()

    expect(store().phase).toBe("review")
    expect(store().capturedSteps).toHaveLength(2)
    expect(store().ignoredCount).toBe(3)
    expect(store().draft?.name).toBe("Prior")
    expect(client.recordStart).not.toHaveBeenCalled()
  })

  it("leaves the store alone when the stranded bundle is gone", async () => {
    dbRecordings.listUnfinishedRecordings.mockResolvedValue([
      { id: RECORDING, status: "captured", updatedAt: 1 },
    ] as never)
    client.recordLoadBundle.mockRejectedValue(new Error("deleted"))
    await recoverOnStartup()
    expect(store().phase).toBe("idle")
  })
})

describe("startControlledTrial", () => {
  async function reachSaved() {
    live()
    await stopRecording()
    adoptManualDraft(
      {
        name: "Manual",
        description: "",
        content: "## Steps\n1. Go",
        tags: [],
        category: "custom",
        allowedTools: [],
      },
      "en"
    )
    await saveSkill(() => "alt")
  }

  it("opens a session with every other enabled skill switched off", async () => {
    // Anything less deliberate leaves the trial telling the user about a skill
    // mix rather than about the skill they just recorded.
    enabledSkillIds.value = ["skill-1", "other-a", "other-b"]
    await reachSaved()

    await expect(startControlledTrial("skill-1")).resolves.toBe("session-1")
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "direct", disabledSkillIds: ["other-a", "other-b"] })
    )
    expect(store().trialSessionId).toBe("session-1")
  })

  it("names the skill the trial exists to exercise, so it is actually loaded", async () => {
    // `disabledSkillIds` alone cannot do this: the recording is saved
    // `disabled` on purpose, so the ordinary resolution path — which honours
    // that flag — would inject nothing and the trial would verify nothing.
    enabledSkillIds.value = ["other-a"]
    await reachSaved()
    await startControlledTrial("skill-1")
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ trialSkillId: "skill-1" }))
  })

  it("disables nothing when the recorded skill is the only enabled one", async () => {
    enabledSkillIds.value = ["skill-1"]
    await reachSaved()
    await startControlledTrial("skill-1")
    expect(createSession.mock.calls[0][0]).toMatchObject({ disabledSkillIds: [] })
  })

  it("reports a session it could not open rather than pretending it started", async () => {
    await reachSaved()
    createSession.mockRejectedValueOnce(new Error("db closed"))
    await expect(startControlledTrial("skill-1")).resolves.toBeNull()
    expect(store().trialSessionId).toBeNull()
  })
})

describe("confirmTrialAndEnable", () => {
  it("is the only thing that turns the skill on", async () => {
    live()
    await stopRecording()
    adoptManualDraft(
      {
        name: "Manual",
        description: "",
        content: "## Steps\n1. Go",
        tags: [],
        category: "custom",
        allowedTools: [],
      },
      "en"
    )
    await saveSkill(() => "alt")
    await startControlledTrial("skill-1")
    expect(setSkillStatus).not.toHaveBeenCalled()

    await confirmTrialAndEnable("skill-1")
    expect(setSkillStatus).toHaveBeenCalledWith("skill-1", "enabled")
    expect(store().trialConfirmed).toBe(true)
  })
})

describe("the asset cache", () => {
  it("evicts the oldest frame once it is full", async () => {
    // A 400-step recording is hundreds of megabytes of base64; the cache exists
    // so scrolling back over a handful of steps is instant, not so the whole
    // recording is resident.
    live()
    await stopRecording()
    client.recordReadAsset.mockImplementation(async (_id: string, assetId: string) => ({
      assetId,
      mimeType: "image/png",
      bytes: `bytes-${assetId}`,
    }))

    for (let i = 0; i < 70; i += 1) await loadAssetBytes(`asset-${i}`)
    const readsAfterFill = client.recordReadAsset.mock.calls.length

    // The newest is still cached...
    await loadAssetBytes("asset-69")
    expect(client.recordReadAsset).toHaveBeenCalledTimes(readsAfterFill)

    // ...and the oldest was evicted, so it costs another read.
    await loadAssetBytes("asset-0")
    expect(client.recordReadAsset).toHaveBeenCalledTimes(readsAfterFill + 1)
  })
})
