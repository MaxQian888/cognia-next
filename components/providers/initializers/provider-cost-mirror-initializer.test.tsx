import { render, waitFor } from "@testing-library/react"

const getTodaysMock = jest.fn().mockResolvedValue({ openai: 1.25 })
const pruneMock = jest.fn().mockResolvedValue(0)
jest.mock("@/lib/db/provider-cost-daily", () => ({
  getTodaysCostByProvider: (...a: unknown[]) => getTodaysMock(...a),
  pruneProviderCostOlderThan: (...a: unknown[]) => pruneMock(...a),
  localDayString: () => "2026-06-05",
}))

import { ProviderCostMirrorInitializer } from "./provider-cost-mirror-initializer"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"

beforeEach(() => {
  getTodaysMock.mockClear()
  pruneMock.mockClear()
  useProviderCostMirrorStore.getState().reset()
})

describe("ProviderCostMirrorInitializer", () => {
  it("hydrates the mirror from Dexie once and prunes old rollups", async () => {
    const { container, rerender } = render(<ProviderCostMirrorInitializer />)
    expect(container).toBeEmptyDOMElement()

    await waitFor(() => {
      expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBeCloseTo(1.25)
    })
    expect(useProviderCostMirrorStore.getState().day).toBe("2026-06-05")
    expect(pruneMock).toHaveBeenCalledWith(90)

    // Re-render must not hydrate again (ref guard).
    rerender(<ProviderCostMirrorInitializer />)
    expect(getTodaysMock).toHaveBeenCalledTimes(1)
  })

  it("leaves the mirror at zero when hydration fails", async () => {
    getTodaysMock.mockRejectedValueOnce(new Error("idb down"))
    render(<ProviderCostMirrorInitializer />)
    await waitFor(() => expect(getTodaysMock).toHaveBeenCalled())
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(0)
  })
})
