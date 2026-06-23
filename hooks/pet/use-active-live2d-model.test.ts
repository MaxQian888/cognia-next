import { renderHook, waitFor } from "@testing-library/react"
import {
  useActiveLive2dModel,
  useCubismCoreAvailable,
  resetCubismCoreProbe,
} from "./use-active-live2d-model"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

// The gate now resolves through the loader's script-injection path, not a HEAD
// fetch. Mock that seam so we control readiness without touching the DOM.
const ensureCubismCore = jest.fn()
const resetCubismCoreLoaderForTests = jest.fn()
jest.mock("@/lib/pet/live2d/core-loader", () => ({
  ensureCubismCore: (...a: unknown[]) => ensureCubismCore(...a),
  resetCubismCoreLoaderForTests: () => resetCubismCoreLoaderForTests(),
}))

const getPetModel = jest.fn()
jest.mock("@/lib/db/pet-models", () => ({
  getPetModel: (...a: unknown[]) => getPetModel(...a),
}))

// useLiveQuery runs the querier and exposes its resolved value; emulate that.
jest.mock("dexie-react-hooks", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    useLiveQuery: (fn: () => Promise<unknown>, _deps: unknown[], initial: unknown) => {
      const [value, setValue] = React.useState(initial)
      React.useEffect(() => {
        let active = true
        void Promise.resolve(fn()).then((v: unknown) => {
          if (active) setValue(v)
        })
        return () => {
          active = false
        }
      }, [fn])
      return value
    },
  }
})

const row = {
  id: "m1",
  name: "Hiyori",
  source: "import" as const,
  settingsPath: "Hiyori.model3.json",
  motionGroups: ["Idle"],
  expressionIds: [],
  totalBytes: 10,
  createdAt: 0,
}

/** Settings with the Live2D skin selected and an active model — the gate's "on" state. */
const live2dSettings: PetSettings = {
  ...DEFAULT_PET_SETTINGS,
  skinId: "live2d",
  activeLive2dModelId: "m1",
}

beforeEach(() => {
  jest.clearAllMocks()
  resetCubismCoreProbe()
  ensureCubismCore.mockResolvedValue(true)
  getPetModel.mockResolvedValue(row)
})

describe("useCubismCoreAvailable", () => {
  it("returns true when the core injection succeeds", async () => {
    ensureCubismCore.mockResolvedValue(true)
    const { result } = renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it("returns false when the core injection fails", async () => {
    ensureCubismCore.mockResolvedValue(false)
    const { result } = renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(result.current).toBe(false))
  })

  it("loads the core via the loader's injection path (not a HEAD fetch)", async () => {
    renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(ensureCubismCore).toHaveBeenCalledTimes(1))
  })

  it("never injects the core when disabled, staying unknown", async () => {
    const { result } = renderHook(() => useCubismCoreAvailable(false))
    // Let any (incorrect) async probe settle before asserting it never fired.
    await Promise.resolve()
    expect(result.current).toBeUndefined()
    expect(ensureCubismCore).not.toHaveBeenCalled()
  })

  it("clears a prior 'ready' when it becomes disabled (skin switched away)", async () => {
    const { result, rerender } = renderHook(({ on }) => useCubismCoreAvailable(on), {
      initialProps: { on: true },
    })
    await waitFor(() => expect(result.current).toBe(true))
    rerender({ on: false })
    await waitFor(() => expect(result.current).toBeUndefined())
  })
})

describe("useActiveLive2dModel", () => {
  it("returns no model and never probes the core when no active id is set", async () => {
    const { result } = renderHook(() => useActiveLive2dModel(DEFAULT_PET_SETTINGS))
    // Nothing async to await meaningfully; assert the steady state.
    await Promise.resolve()
    expect(result.current.modelId).toBeUndefined()
    expect(result.current.row).toBeUndefined()
    expect(result.current.coreReady).toBeUndefined()
    expect(getPetModel).not.toHaveBeenCalled()
    expect(ensureCubismCore).not.toHaveBeenCalled()
  })

  it("reads the active model row reactively", async () => {
    const settings: PetSettings = { ...DEFAULT_PET_SETTINGS, activeLive2dModelId: "m1" }
    const { result } = renderHook(() => useActiveLive2dModel(settings))
    await waitFor(() => expect(result.current.row).toEqual(row))
    expect(result.current.modelId).toBe("m1")
    expect(getPetModel).toHaveBeenCalledWith("m1")
  })

  it("does not probe the core when a model is active but the skin is not live2d", async () => {
    const settings: PetSettings = { ...DEFAULT_PET_SETTINGS, activeLive2dModelId: "m1" }
    const { result } = renderHook(() => useActiveLive2dModel(settings))
    await waitFor(() => expect(result.current.row).toEqual(row))
    expect(result.current.coreReady).toBeUndefined()
    expect(ensureCubismCore).not.toHaveBeenCalled()
  })

  it("does not probe the core when live2d is selected but no model is active", async () => {
    const settings: PetSettings = { ...DEFAULT_PET_SETTINGS, skinId: "live2d" }
    const { result } = renderHook(() => useActiveLive2dModel(settings))
    await Promise.resolve()
    expect(result.current.coreReady).toBeUndefined()
    expect(ensureCubismCore).not.toHaveBeenCalled()
  })

  it("probes the core only when live2d is selected with an active model", async () => {
    const { result } = renderHook(() => useActiveLive2dModel(live2dSettings))
    await waitFor(() => expect(result.current.coreReady).toBe(true))
    expect(ensureCubismCore).toHaveBeenCalledTimes(1)
    expect(result.current.modelId).toBe("m1")
  })
})
