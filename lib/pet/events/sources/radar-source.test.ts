import Dexie from "dexie"
import { createRadarSource, type RadarObserver, type RadarReportStamp } from "./radar-source"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"
import type { PetEvent } from "@/types/pet"

const mockLatestReport = jest.fn()
jest.mock("@/lib/db/radar-reports", () => ({
  getLatestRadarReport: (...args: unknown[]) => mockLatestReport(...args),
}))

function setup(opts: { enabled?: () => boolean } = {}) {
  let push: (latest: RadarReportStamp | undefined) => void = () => {}
  const dispose = jest.fn()
  const observe: RadarObserver = (onLatest) => {
    push = onLatest
    return dispose
  }
  const events: PetEvent[] = []
  const off = createRadarSource({ observe, isEnabled: opts.enabled ?? (() => true) })((e) =>
    events.push({ ...e, at: 0 })
  )
  return { push: (latest?: RadarReportStamp) => push(latest), events, off, dispose }
}

const report = (id: string, generatedAt: number): RadarReportStamp => ({ id, generatedAt })

describe("radar source", () => {
  it("ignores the report that already existed when it attached", () => {
    const { push, events } = setup()
    push(report("old", 100))
    expect(events).toHaveLength(0)
  })

  it("fires once for a report saved after it attached", () => {
    const { push, events } = setup()
    push(report("old", 100))
    push(report("new", 200))
    expect(events).toEqual([
      expect.objectContaining({ source: "radar", kind: "radarReport", meta: { reportId: "new" } }),
    ])
  })

  it("takes an empty first result as the baseline, so the very first report fires", () => {
    const { push, events } = setup()
    push(undefined) // fresh install: no report yet
    push(report("first", 100))
    expect(events.map((e) => e.meta)).toEqual([{ reportId: "first" }])
  })

  it("does not fire twice for the same report (the prune after a save re-fires the query)", () => {
    const { push, events } = setup()
    push(undefined)
    push(report("r1", 100))
    push(report("r1", 100))
    expect(events).toHaveLength(1)
  })

  it("ignores an older report that becomes the latest again when a newer one is deleted", () => {
    const { push, events } = setup()
    push(report("a", 100))
    push(report("b", 200)) // → fires
    push(report("a", 100)) // "b" deleted; "a" is latest again — not news
    expect(events.map((e) => e.meta)).toEqual([{ reportId: "b" }])
  })

  it("stays quiet with the radar switched off, and never replays that report later", () => {
    let enabled = false
    const { push, events } = setup({ enabled: () => enabled })
    push(undefined)
    push(report("while-off", 100))
    expect(events).toHaveLength(0)
    enabled = true
    push(report("while-off", 100)) // the query re-fires; still not news
    expect(events).toHaveLength(0)
    push(report("fresh", 200))
    expect(events.map((e) => e.meta)).toEqual([{ reportId: "fresh" }])
  })

  it("carries only the report id, never report content", () => {
    const { push, events } = setup()
    push(undefined)
    push({ id: "r1", generatedAt: 1, verdict: "you read job listings" } as RadarReportStamp)
    expect(events[0].meta).toEqual({ reportId: "r1" })
  })

  it("dispose tears the observation down", () => {
    const { off, dispose } = setup()
    off()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("reads the radar's own opt-in from settings by default", () => {
    let push: (latest: RadarReportStamp | undefined) => void = () => {}
    const events: PetEvent[] = []
    createRadarSource({
      observe: (onLatest) => {
        push = onLatest
        return () => {}
      },
    })((e) => events.push({ ...e, at: 0 }))
    push(undefined)

    useSettingsStore.setState({ settings: { attentionRadar: { enabled: false } } as AppSettings })
    push(report("off", 100))
    useSettingsStore.setState({ settings: { attentionRadar: { enabled: true } } as AppSettings })
    push(report("on", 200))

    expect(events.map((e) => e.meta)).toEqual([{ reportId: "on" }])
  })
})

describe("the default Dexie observer", () => {
  afterEach(() => jest.restoreAllMocks())

  it("strips each report to id and generatedAt inside the query, so content never reaches the source", async () => {
    mockLatestReport.mockResolvedValue({
      id: "r9",
      generatedAt: 50,
      verdict: "you have been reading job listings",
      atAGlance: ["private"],
    })
    let query: () => Promise<unknown> = async () => undefined
    const unsubscribe = jest.fn()
    jest.spyOn(Dexie, "liveQuery").mockImplementation(((fn: () => Promise<unknown>) => {
      query = fn
      return { subscribe: () => ({ unsubscribe }) }
    }) as unknown as typeof Dexie.liveQuery)

    const off = createRadarSource({ isEnabled: () => true })(() => {})
    expect(await query()).toEqual({ id: "r9", generatedAt: 50 })
    expect(mockLatestReport).toHaveBeenCalledWith("self")
    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('passes "no report yet" through as undefined', async () => {
    mockLatestReport.mockResolvedValue(undefined)
    let query: () => Promise<unknown> = async () => "unset"
    jest.spyOn(Dexie, "liveQuery").mockImplementation(((fn: () => Promise<unknown>) => {
      query = fn
      return { subscribe: () => ({ unsubscribe: () => {} }) }
    }) as unknown as typeof Dexie.liveQuery)
    createRadarSource({ isEnabled: () => true })(() => {})
    expect(await query()).toBeUndefined()
  })
})
