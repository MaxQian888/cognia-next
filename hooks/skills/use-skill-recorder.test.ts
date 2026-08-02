/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  __resetRecorderAvailabilityForTesting,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import type { RecordedStep } from "@/lib/skills/recording/types"

import {
  useRecorderAvailable,
  useRecorderCandidate,
  useRecorderDraft,
  useRecorderError,
  useRecorderIncludedCount,
  useRecorderInterrupt,
  useRecorderOptions,
  useRecorderPhase,
  useRecorderSelectedStep,
  useRecorderSheetOpen,
  useRecorderStage,
  useRecorderSteps,
  useRecorderUnconfirmedVariables,
  useRecorderUsage,
  useRecorderVariables,
} from "./use-skill-recorder"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"

function step(seq: number, patch: Partial<RecordedStep> = {}): RecordedStep {
  return { seq, tsMs: seq * 100, kind: "click", ...patch }
}

function store() {
  return useRecorderStore.getState()
}

beforeEach(() => {
  __resetRecorderAvailabilityForTesting()
  useRecorderStore.getState().reset()
})

describe("useRecorderAvailable", () => {
  it("is false until the owning plugin publishes", () => {
    const { result } = renderHook(() => useRecorderAvailable())
    expect(result.current).toBe(false)
  })

  it("re-renders when the plugin publishes and when it is disabled again", () => {
    const { result } = renderHook(() => useRecorderAvailable())
    act(() => setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" }))
    expect(result.current).toBe(true)
    act(() => setRecorderAvailability({ available: false, pluginId: null }))
    expect(result.current).toBe(false)
  })
})

describe("phase and stage", () => {
  it("maps the phase to its stage", () => {
    const { result } = renderHook(() => ({
      phase: useRecorderPhase(),
      stage: useRecorderStage(),
    }))
    expect(result.current).toEqual({ phase: "idle", stage: "setup" })

    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
      store().dispatch({ type: "PREFLIGHT_START" })
    })
    expect(result.current).toEqual({ phase: "preflight", stage: "setup" })
  })

  it("lets an explicit override win over the derived stage", () => {
    // Going back to an earlier stage is a user action, not a phase change; the
    // phase still describes what the session is actually doing.
    const { result } = renderHook(() => useRecorderStage())
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
      store().setUi({ stageOverride: "generate" })
    })
    expect(result.current).toBe("generate")
    expect(store().phase).toBe("setup")
  })
})

describe("useRecorderSheetOpen", () => {
  it("tracks the Sheet independently of the phase", () => {
    const { result } = renderHook(() => useRecorderSheetOpen())
    expect(result.current).toBe(false)
    act(() => {
      store().dispatch({ type: "OPEN", source: "palette" })
    })
    expect(result.current).toBe(true)
    act(() => store().setUi({ sheetOpen: false }))
    expect(result.current).toBe(false)
  })
})

describe("step selectors", () => {
  it("exposes the derived views and counts only the included ones", () => {
    const { result } = renderHook(() => ({
      steps: useRecorderSteps(),
      included: useRecorderIncludedCount(),
    }))
    act(() => store().setCapturedSteps([step(1), step(2), step(3)]))
    expect(result.current.steps).toHaveLength(3)
    expect(result.current.included).toBe(3)

    act(() => store().setEdits({ bySeq: { 2: { excluded: true } }, manual: [] }))
    expect(result.current.included).toBe(2)
  })

  it("does not re-render for an unrelated store write", () => {
    // Without `useShallow` the array identity changes on every write and React
    // 19 + zustand v5 spin — the loop `skill-panel-toolbar.tsx` documents.
    let renders = 0
    renderHook(() => {
      renders += 1
      return useRecorderSteps()
    })
    const before = renders
    act(() => store().setToolsConfirmed(true))
    expect(renders).toBe(before)
  })

  it("resolves the selected step, and null when the selection is stale", () => {
    const { result } = renderHook(() => useRecorderSelectedStep())
    act(() => {
      store().setCapturedSteps([step(1), step(2)])
      store().setUi({ selectedStepSeq: 2 })
    })
    expect(result.current?.seq).toBe(2)

    act(() => store().dropStep(2))
    expect(result.current).toBeNull()
  })

  it("is null with nothing selected", () => {
    const { result } = renderHook(() => useRecorderSelectedStep())
    act(() => store().setCapturedSteps([step(1)]))
    expect(result.current).toBeNull()
  })
})

describe("review and draft selectors", () => {
  function reachReview() {
    store().dispatch({ type: "OPEN", source: "toolbar" })
    store().dispatch({ type: "PREFLIGHT_START" })
    store().dispatch({ type: "PREFLIGHT_OK" })
    store().dispatch({
      type: "NATIVE_STARTED",
      recordingId: RECORDING,
      startedAt: 1,
      scope: { kind: "desktop" },
      limits: {
        maxDurationMs: 3_600_000,
        maxSteps: 500,
        maxBundleBytes: 1,
        maxGlobalBytes: 1,
      },
    })
    store().dispatch({ type: "STOP_REQUESTED" })
    store().dispatch({ type: "STOPPED", steps: [step(1)], ignoredCount: 0, bundleId: RECORDING })
  }

  it("exposes variables, usage and options", () => {
    const { result } = renderHook(() => ({
      variables: useRecorderVariables(),
      usage: useRecorderUsage(),
      options: useRecorderOptions(),
    }))
    act(() => {
      reachReview()
      store().dispatch({
        type: "SET_VARIABLES",
        variables: [{ name: "orderId", kind: "variable", seq: 1, confirmed: false }],
      })
      store().setOptions({ captureScreenshots: false })
    })
    expect(result.current.variables).toHaveLength(1)
    expect(result.current.options.captureScreenshots).toBe(false)
    expect(result.current.usage).toEqual([])
  })

  it("keeps a regeneration candidate separate from the draft", () => {
    const { result } = renderHook(() => ({
      draft: useRecorderDraft(),
      candidate: useRecorderCandidate(),
    }))
    const draft = {
      name: "First",
      description: "",
      content: "## Steps\n1. One",
      tags: [],
      category: "custom",
      allowedTools: [],
    }
    act(() => {
      reachReview()
      store().dispatch({ type: "GENERATE_REQUESTED" })
      store().dispatch({
        type: "GENERATED",
        draft,
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
    })
    expect(result.current.draft?.name).toBe("First")
    expect(result.current.candidate).toBeNull()
  })

  it("exposes the error and the interrupt", () => {
    const { result } = renderHook(() => ({
      error: useRecorderError(),
      interrupt: useRecorderInterrupt(),
    }))
    act(() => {
      store().dispatch({ type: "OPEN", source: "toolbar" })
      store().dispatch({ type: "PREFLIGHT_START" })
      store().dispatch({
        type: "PREFLIGHT_FAIL",
        error: { code: "pluginDisabled", retriable: true },
      })
    })
    expect(result.current.error?.code).toBe("pluginDisabled")
    expect(result.current.interrupt).toBeNull()

    act(() => store().dispatch({ type: "INTERRUPT", reason: "killSwitch" }))
    expect(result.current.interrupt).toMatchObject({ reason: "killSwitch", retriable: false })
  })
})

describe("useRecorderUnconfirmedVariables", () => {
  const suggestion = (seq: number, confirmed: boolean) => ({
    seq,
    name: `input_${seq}`,
    kind: "variable" as const,
    sample: "acme corp",
    confirmed,
  })

  it("is zero when the recording produced no suggestions", () => {
    const { result } = renderHook(() => useRecorderUnconfirmedVariables())
    expect(result.current).toBe(0)
  })

  it("counts only the unanswered ones, and falls to zero as they are answered", () => {
    // This is what disables Continue and Generate — the same number the reducer
    // gates on, so the UI cannot promise an action the machine will refuse.
    const { result } = renderHook(() => useRecorderUnconfirmedVariables())
    act(() => {
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
      store().dispatch({ type: "STOP_REQUESTED" })
      store().dispatch({ type: "STOPPED", steps: [], ignoredCount: 0, bundleId: RECORDING })
      store().dispatch({
        type: "SET_VARIABLES",
        variables: [suggestion(1, false), suggestion(2, true), suggestion(3, false)],
      })
    })
    expect(result.current).toBe(2)

    act(() => {
      store().dispatch({
        type: "SET_VARIABLES",
        variables: [suggestion(1, true), suggestion(2, true), suggestion(3, true)],
      })
    })
    expect(result.current).toBe(0)
  })
})
