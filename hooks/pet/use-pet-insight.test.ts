import { renderHook, act, waitFor } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/radar-reports", () => ({ getLatestRadarReport: jest.fn() }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))

const setBubble = jest.fn()
jest.mock("@/stores/pet/pet-store", () => ({
  usePetStore: { getState: () => ({ setBubble }) },
}))

import { useLiveQuery } from "dexie-react-hooks"
import { getLatestRadarReport } from "@/lib/db/radar-reports"
import { useSettingsStore } from "@/stores/settings"
import { usePetInsight } from "./use-pet-insight"

const mockLive = useLiveQuery as jest.Mock
const mockSeed = getLatestRadarReport as jest.Mock
const mockSettings = useSettingsStore as unknown as jest.Mock

function radarEnabled(enabled: boolean) {
  mockSettings.mockImplementation((sel: (s: unknown) => unknown) =>
    sel({ settings: { attentionRadar: { enabled } } })
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSeed.mockResolvedValue(undefined)
  mockLive.mockReturnValue(undefined)
})

describe("usePetInsight", () => {
  it("teases a bubble when a fresh report lands", async () => {
    radarEnabled(true)
    const { rerender } = renderHook(() => usePetInsight(true))
    await waitFor(() => expect(mockSeed).toHaveBeenCalled())
    await act(async () => {}) // flush the baseline-seed promise → ready

    mockLive.mockReturnValue({ id: "r1", verdict: "you love rust" })
    rerender()
    expect(setBubble).toHaveBeenCalledWith({ text: "you love rust", origin: "system" })
  })

  it("does not tease when radar is disabled", async () => {
    radarEnabled(false)
    const { rerender } = renderHook(() => usePetInsight(true))
    await act(async () => {})
    mockLive.mockReturnValue({ id: "r1", verdict: "x" })
    rerender()
    expect(setBubble).not.toHaveBeenCalled()
  })

  it("does not tease a report that already existed on mount", async () => {
    radarEnabled(true)
    mockSeed.mockResolvedValue({ id: "r1" })
    mockLive.mockReturnValue({ id: "r1", verdict: "old" })
    renderHook(() => usePetInsight(true))
    await act(async () => {})
    expect(setBubble).not.toHaveBeenCalled()
  })
})
