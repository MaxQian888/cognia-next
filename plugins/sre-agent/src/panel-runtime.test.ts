import type { PluginDexieAPI } from "@cognia/plugin-sdk"
import type { SreRuntime } from "./runtime"
import {
  clearSrePanelRuntime,
  notifySreToolActivity,
  peekSrePanelRuntime,
  recentSreToolActivity,
  setSrePanelRuntime,
  subscribeSreToolActivity,
} from "./panel-runtime"

const runtime = {} as SreRuntime
const dexie = {} as PluginDexieAPI

function activity(index: number) {
  return { tool: "sre_query_logs", evidenceIds: [`log_${index}`], at: `t${index}` }
}

describe("panel runtime bridge", () => {
  afterEach(() => clearSrePanelRuntime())

  it("hands the panel what activate parked, and nothing after deactivate", () => {
    expect(peekSrePanelRuntime()).toBeNull()
    setSrePanelRuntime({ runtime, dexie, contextPanels: null })
    expect(peekSrePanelRuntime()).toEqual({ runtime, dexie, contextPanels: null })
    clearSrePanelRuntime()
    expect(peekSrePanelRuntime()).toBeNull()
  })

  it("drops tool activity published while the plugin is not active", () => {
    notifySreToolActivity(activity(1))
    expect(recentSreToolActivity()).toEqual([])
  })

  it("fans activity out to subscribers in order", () => {
    setSrePanelRuntime({ runtime, dexie: null, contextPanels: null })
    const seen: number[] = []
    const unsubscribe = subscribeSreToolActivity((latest) => seen.push(latest.length))

    notifySreToolActivity(activity(1))
    notifySreToolActivity(activity(2))
    expect(seen).toEqual([1, 2])
    expect(recentSreToolActivity().map((entry) => entry.evidenceIds[0])).toEqual(["log_1", "log_2"])

    unsubscribe()
    notifySreToolActivity(activity(3))
    expect(seen).toEqual([1, 2])
    expect(recentSreToolActivity()).toHaveLength(3)
  })

  it("keeps only the most recent window of activity", () => {
    setSrePanelRuntime({ runtime, dexie: null, contextPanels: null })
    for (let index = 0; index < 60; index += 1) notifySreToolActivity(activity(index))
    const recent = recentSreToolActivity()
    expect(recent).toHaveLength(50)
    expect(recent[0].evidenceIds[0]).toBe("log_10")
  })

  it("forgets activity and listeners on deactivate", () => {
    setSrePanelRuntime({ runtime, dexie: null, contextPanels: null })
    const seen: number[] = []
    subscribeSreToolActivity((latest) => seen.push(latest.length))
    notifySreToolActivity(activity(1))
    clearSrePanelRuntime()
    expect(recentSreToolActivity()).toEqual([])

    setSrePanelRuntime({ runtime, dexie: null, contextPanels: null })
    notifySreToolActivity(activity(2))
    expect(seen).toEqual([1])
  })
})
