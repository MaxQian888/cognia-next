import { render, waitFor } from "@testing-library/react"

const getTodaysMock = jest.fn().mockResolvedValue({ openai: 1.25 })
const pruneMock = jest.fn().mockResolvedValue(0)
const pruneSessionUsageMock = jest.fn().mockResolvedValue(0)
const rebuildMock = jest.fn().mockResolvedValue({ days: 90, buckets: 0, rows: 0 })
let installedSink:
  ((c: { providerId: string; day: string; providerTotalUsd: number }) => void) | null = null
const setSinkMock = jest.fn((sink: typeof installedSink) => {
  installedSink = sink
  return () => {
    installedSink = null
  }
})

jest.mock("@/lib/db/provider-cost-daily", () => ({
  getTodaysCostByProvider: (...a: unknown[]) => getTodaysMock(...a),
  pruneProviderCostOlderThan: (...a: unknown[]) => pruneMock(...a),
  localDayString: () => "2026-06-05",
}))
jest.mock("@/lib/db/session-usage", () => ({
  pruneSessionUsageOlderThan: (...a: unknown[]) => pruneSessionUsageMock(...a),
}))
jest.mock("@/lib/usage/usage-ledger", () => ({
  rebuildProviderCostDaily: (...a: unknown[]) => rebuildMock(...a),
  setBudgetMirrorSink: (...a: unknown[]) => setSinkMock(...(a as [typeof installedSink])),
  USAGE_LEDGER_RECONCILE_MARKER: "usage.ledger.reconciled.v218",
}))

import {
  markReconciled,
  ProviderCostMirrorInitializer,
  reconcileNeeded,
} from "./provider-cost-mirror-initializer"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"

beforeEach(() => {
  getTodaysMock.mockClear()
  pruneMock.mockClear()
  pruneSessionUsageMock.mockClear()
  rebuildMock.mockClear()
  setSinkMock.mockClear()
  installedSink = null
  window.localStorage.clear()
  useProviderCostMirrorStore.getState().reset()
})

describe("reconcileNeeded", () => {
  it("is needed when the marker is absent", () => {
    expect(reconcileNeeded(window.localStorage)).toBe(true)
  })

  it("is satisfied once the marker is written", () => {
    markReconciled(window.localStorage)
    expect(reconcileNeeded(window.localStorage)).toBe(false)
  })

  it("errs toward rebuilding when storage is unavailable", () => {
    expect(reconcileNeeded(null)).toBe(true)
    expect(
      reconcileNeeded({
        getItem: () => {
          throw new Error("blocked")
        },
      })
    ).toBe(true)
  })

  it("never throws when the marker cannot be written", () => {
    expect(() =>
      markReconciled({
        setItem: () => {
          throw new Error("quota")
        },
      })
    ).not.toThrow()
    expect(() => markReconciled(null)).not.toThrow()
  })
})

describe("ProviderCostMirrorInitializer", () => {
  it("hydrates the mirror from Dexie once and prunes old usage rollups", async () => {
    const { container, rerender } = render(<ProviderCostMirrorInitializer />)
    expect(container).toBeEmptyDOMElement()

    await waitFor(() => {
      expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBeCloseTo(1.25)
    })
    expect(useProviderCostMirrorStore.getState().day).toBe("2026-06-05")
    expect(pruneMock).toHaveBeenCalledWith(90)
    expect(pruneSessionUsageMock).toHaveBeenCalledWith(90)

    // Re-render must not hydrate again (ref guard).
    rerender(<ProviderCostMirrorInitializer />)
    expect(getTodaysMock).toHaveBeenCalledTimes(1)
  })

  it("installs the ledger sink so a committed turn snaps the mirror", async () => {
    render(<ProviderCostMirrorInitializer />)
    await waitFor(() => expect(setSinkMock).toHaveBeenCalled())
    expect(installedSink).not.toBeNull()

    installedSink?.({ providerId: "openai", day: "2026-06-05", providerTotalUsd: 9.5 })
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBeCloseTo(9.5)
  })

  it("uninstalls the sink on unmount", async () => {
    const { unmount } = render(<ProviderCostMirrorInitializer />)
    await waitFor(() => expect(installedSink).not.toBeNull())
    unmount()
    expect(installedSink).toBeNull()
  })

  it("rebuilds the projection once, then marks it done", async () => {
    render(<ProviderCostMirrorInitializer />)
    await waitFor(() => expect(rebuildMock).toHaveBeenCalledWith(90))
    await waitFor(() =>
      expect(window.localStorage.getItem("usage.ledger.reconciled.v218")).toBe("1")
    )
  })

  it("skips the rebuild when the marker is already set", async () => {
    window.localStorage.setItem("usage.ledger.reconciled.v218", "1")
    render(<ProviderCostMirrorInitializer />)
    await waitFor(() => expect(getTodaysMock).toHaveBeenCalled())
    expect(rebuildMock).not.toHaveBeenCalled()
  })

  it("leaves the marker unset when the rebuild fails, so the next boot retries", async () => {
    rebuildMock.mockRejectedValueOnce(new Error("txn aborted"))
    render(<ProviderCostMirrorInitializer />)
    await waitFor(() => expect(getTodaysMock).toHaveBeenCalled())
    expect(window.localStorage.getItem("usage.ledger.reconciled.v218")).toBeNull()
  })

  it("hydrates AFTER the rebuild so it never seeds pre-repair totals", async () => {
    const order: string[] = []
    rebuildMock.mockImplementationOnce(async () => {
      order.push("rebuild")
      return { days: 90, buckets: 0, rows: 0 }
    })
    getTodaysMock.mockImplementationOnce(async () => {
      order.push("hydrate")
      return { openai: 1.25 }
    })
    render(<ProviderCostMirrorInitializer />)
    await waitFor(() => expect(order).toEqual(["rebuild", "hydrate"]))
  })

  it("leaves the mirror at zero when hydration fails", async () => {
    getTodaysMock.mockRejectedValueOnce(new Error("idb down"))
    render(<ProviderCostMirrorInitializer />)
    await waitFor(() => expect(getTodaysMock).toHaveBeenCalled())
    expect(useProviderCostMirrorStore.getState().getTodaySpend("openai")).toBe(0)
  })
})
