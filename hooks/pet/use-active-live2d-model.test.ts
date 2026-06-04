import { renderHook, waitFor } from "@testing-library/react"
import {
  useActiveLive2dModel,
  useCubismCoreAvailable,
  resetCubismCoreProbe,
} from "./use-active-live2d-model"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

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

beforeEach(() => {
  jest.clearAllMocks()
  resetCubismCoreProbe()
  delete (window as { Live2DCubismCore?: unknown }).Live2DCubismCore
  getPetModel.mockResolvedValue(row)
})

describe("useCubismCoreAvailable", () => {
  it("returns true when the HEAD probe is ok", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock
    const { result } = renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it("returns false when the HEAD probe fails the response", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as jest.Mock
    const { result } = renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(result.current).toBe(false))
  })

  it("returns false when the fetch rejects", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as jest.Mock
    const { result } = renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(result.current).toBe(false))
  })

  it("short-circuits to true when the core global is already present", async () => {
    ;(window as { Live2DCubismCore?: unknown }).Live2DCubismCore = {}
    global.fetch = jest.fn() as jest.Mock
    const { result } = renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(result.current).toBe(true))
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("caches the probe across consumers", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock
    const a = renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(a.result.current).toBe(true))
    renderHook(() => useCubismCoreAvailable())
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
  })
})

describe("useActiveLive2dModel", () => {
  it("returns no model when no active id is set", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock
    const { result } = renderHook(() => useActiveLive2dModel(DEFAULT_PET_SETTINGS))
    await waitFor(() => expect(result.current.coreReady).toBe(true))
    expect(result.current.modelId).toBeUndefined()
    expect(result.current.row).toBeUndefined()
    expect(getPetModel).not.toHaveBeenCalled()
  })

  it("reads the active model row reactively", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock
    const settings: PetSettings = { ...DEFAULT_PET_SETTINGS, activeLive2dModelId: "m1" }
    const { result } = renderHook(() => useActiveLive2dModel(settings))
    await waitFor(() => expect(result.current.row).toEqual(row))
    expect(result.current.modelId).toBe("m1")
    expect(getPetModel).toHaveBeenCalledWith("m1")
  })
})
