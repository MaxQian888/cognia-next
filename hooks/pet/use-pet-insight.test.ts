import { renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/db/radar-reports", () => ({ getRadarReport: jest.fn() }))

const sayAsPet = jest.fn()
jest.mock("@/lib/pet/bubbles/say", () => ({
  sayAsPet: (...args: unknown[]) => sayAsPet(...args),
}))

import { getRadarReport } from "@/lib/db/radar-reports"
import { __resetPetEventBusForTesting, emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { usePetStore } from "@/stores/pet/pet-store"
import { INSIGHT_BUBBLE_MS, usePetInsight } from "./use-pet-insight"

const mockReport = getRadarReport as jest.Mock
const OPEN_INSIGHTS = { kind: "open-console", tab: "insights" }

function report(over: Record<string, unknown> = {}) {
  return { id: "r1", verdict: "you love rust", atAGlance: ["async everywhere"], ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetPetEventBusForTesting()
  usePetStore.setState({ bubble: null })
  mockReport.mockResolvedValue(report())
  sayAsPet.mockReturnValue({ ok: true, text: "you love rust", clearsAt: 0 })
})

/** `null` lands an event with no report id at all. */
function landReport(reportId: string | null = "r1", at = 4) {
  emitPetEvent({
    source: "radar",
    kind: "radarReport",
    ...(reportId ? { meta: { reportId } } : {}),
    at,
  })
}

describe("usePetInsight", () => {
  it("speaks the new report's verdict through the gated path, with the Open Insights action", async () => {
    renderHook(() => usePetInsight(true))
    landReport("r1")
    await waitFor(() => expect(sayAsPet).toHaveBeenCalledTimes(1))
    expect(mockReport).toHaveBeenCalledWith("r1")
    expect(sayAsPet).toHaveBeenCalledWith("you love rust", {
      origin: "system",
      action: OPEN_INSIGHTS,
      durationMs: INSIGHT_BUBBLE_MS,
    })
  })

  it("falls back to the first at-a-glance point when there is no verdict", async () => {
    mockReport.mockResolvedValue(report({ verdict: "  " }))
    renderHook(() => usePetInsight(true))
    landReport()
    await waitFor(() => expect(sayAsPet).toHaveBeenCalled())
    expect(sayAsPet.mock.calls[0][0]).toBe("async everywhere")
  })

  it.each(["pii", "rate-limited"])(
    "announces the report with fixed copy when the line is refused (%s)",
    async (reason) => {
      sayAsPet.mockReturnValue({ ok: false, reason })
      renderHook(() => usePetInsight(true))
      landReport("r1", 4)
      await waitFor(() => expect(usePetStore.getState().bubble).not.toBeNull())
      expect(usePetStore.getState().bubble).toEqual({
        text: "Your new Attention Radar report is ready!",
        origin: "template",
        action: OPEN_INSIGHTS,
      })
    }
  )

  it("announces with fixed copy when the report has nothing to say, without trying the gate", async () => {
    mockReport.mockResolvedValue(report({ verdict: "", atAGlance: [] }))
    renderHook(() => usePetInsight(true))
    landReport("r1", 5)
    await waitFor(() => expect(usePetStore.getState().bubble).not.toBeNull())
    expect(sayAsPet).not.toHaveBeenCalled()
    expect(usePetStore.getState().bubble?.text).toBe("Fresh insights just landed — take a look?")
  })

  it("still announces the report when it cannot be read", async () => {
    mockReport.mockRejectedValue(new Error("dexie closed"))
    renderHook(() => usePetInsight(true))
    landReport()
    await waitFor(() => expect(usePetStore.getState().bubble?.action).toEqual(OPEN_INSIGHTS))
  })

  it("clears its own fallback bubble after the hold, but not a newer one", async () => {
    jest.useFakeTimers()
    try {
      sayAsPet.mockReturnValue({ ok: false, reason: "pii" })
      renderHook(() => usePetInsight(true))
      landReport("r1", 4)
      await waitFor(() => expect(usePetStore.getState().bubble).not.toBeNull())
      jest.advanceTimersByTime(INSIGHT_BUBBLE_MS)
      expect(usePetStore.getState().bubble).toBeNull()

      landReport("r2", 6)
      await waitFor(() => expect(usePetStore.getState().bubble).not.toBeNull())
      usePetStore.getState().setBubble({ text: "something newer", origin: "template" })
      jest.advanceTimersByTime(INSIGHT_BUBBLE_MS)
      expect(usePetStore.getState().bubble?.text).toBe("something newer")
    } finally {
      jest.useRealTimers()
    }
  })

  it("ignores every other event kind", async () => {
    renderHook(() => usePetInsight(true))
    emitPetEvent({ source: "scheduler", kind: "scheduledRun", at: 1 })
    emitPetEvent({ source: "twin", kind: "twinMilestone", at: 2 })
    await new Promise((r) => setTimeout(r, 0))
    expect(mockReport).not.toHaveBeenCalled()
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("stays quiet while disabled (bubbles muted or the widget off)", async () => {
    renderHook(() => usePetInsight(false))
    landReport()
    await new Promise((r) => setTimeout(r, 0))
    expect(mockReport).not.toHaveBeenCalled()
    expect(sayAsPet).not.toHaveBeenCalled()
  })

  it("announces a report event that carries no id with the fixed copy, without reading anything", async () => {
    renderHook(() => usePetInsight(true))
    landReport(null, 4)
    await waitFor(() => expect(usePetStore.getState().bubble).not.toBeNull())
    expect(mockReport).not.toHaveBeenCalled()
    expect(sayAsPet).not.toHaveBeenCalled()
    expect(usePetStore.getState().bubble).toMatchObject({
      origin: "template",
      action: OPEN_INSIGHTS,
    })
  })

  it("drops the bubble if it unmounts while the report is still being read", async () => {
    let release: (value: unknown) => void = () => {}
    mockReport.mockReturnValue(new Promise((resolve) => (release = resolve)))
    const { unmount } = renderHook(() => usePetInsight(true))
    landReport("r1")
    await waitFor(() => expect(mockReport).toHaveBeenCalled())
    unmount()
    release(report())
    await new Promise((r) => setTimeout(r, 0))
    expect(sayAsPet).not.toHaveBeenCalled()
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("stops listening on unmount", async () => {
    const { unmount } = renderHook(() => usePetInsight(true))
    unmount()
    landReport()
    await new Promise((r) => setTimeout(r, 0))
    expect(mockReport).not.toHaveBeenCalled()
  })
})
