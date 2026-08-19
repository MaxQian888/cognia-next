/** @jest-environment jsdom */

jest.mock("@/lib/db/behavior-events", () => ({ appendBehaviorEvent: jest.fn() }))
jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: jest.fn(() => true) }))

import type { BehaviorEventEnvelope } from "@/lib/telemetry/events/track-event"
import { configureBehaviorEventExporters } from "@/lib/telemetry/events/track-event"
import { BEHAVIOR_TELEMETRY_STORAGE_KEY } from "@/lib/telemetry/events/settings"
import {
  APP_LAUNCH_STORAGE_KEY,
  consumeFirstLaunchFlag,
  toReportableRoute,
  trackAppLaunched,
  trackScreenViewed,
} from "./app-session"

const exported: BehaviorEventEnvelope[] = []

beforeEach(() => {
  localStorage.clear()
  exported.length = 0
  configureBehaviorEventExporters([
    {
      id: "test",
      export: async (event) => {
        exported.push(event)
      },
    },
  ])
})

afterEach(() => configureBehaviorEventExporters([]))

describe("toReportableRoute", () => {
  it("keeps at most two static segments", () => {
    expect(toReportableRoute("/")).toBe("/")
    expect(toReportableRoute("/settings")).toBe("/settings")
    expect(toReportableRoute("/settings/appearance")).toBe("/settings/appearance")
    expect(toReportableRoute("/settings/appearance/theme")).toBe("/settings/appearance")
  })

  it("drops query strings and fragments before reporting", () => {
    expect(toReportableRoute("/memory?q=my-secret-note#hit-3")).toBe("/memory")
  })

  it("collapses anything that does not look like a static route name", () => {
    // A future dynamic segment, a deep link, or an id must never become a
    // route label — the whole path degrades instead of leaking one segment.
    expect(toReportableRoute("/chat/8f14e45fce39a3ee")).toBe("other")
    expect(toReportableRoute("/Users/someone/notes")).toBe("other")
    expect(toReportableRoute("")).toBe("other")
    expect(toReportableRoute(null)).toBe("other")
  })
})

describe("consumeFirstLaunchFlag", () => {
  it("is true exactly once per install", () => {
    expect(consumeFirstLaunchFlag(localStorage, 1_700_000_000_000)).toBe(true)
    expect(localStorage.getItem(APP_LAUNCH_STORAGE_KEY)).toBe("1700000000000")
    expect(consumeFirstLaunchFlag(localStorage, 1_700_000_001_000)).toBe(false)
  })

  it("reports a returning install when storage is unavailable", () => {
    expect(consumeFirstLaunchFlag(undefined, 1)).toBe(false)
  })
})

describe("app-session events", () => {
  it("stays silent until the user opts in", async () => {
    await expect(
      trackAppLaunched({ runtime: "tauri", appVersion: "1.2.3", locale: "en" })
    ).resolves.toBe(false)
    await expect(trackScreenViewed("/memory")).resolves.toBe(false)
    expect(exported).toEqual([])
  })

  it("emits the launch and screen events under the app category once opted in", async () => {
    localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
    await trackAppLaunched({
      runtime: "tauri",
      appVersion: "1.2.3",
      locale: "zh-CN",
      storage: localStorage,
      now: () => 1_700_000_000_000,
    })
    await trackScreenViewed("/settings/observability")

    expect(exported).toEqual([
      expect.objectContaining({
        name: "app.launched",
        category: "app",
        attributes: {
          runtime: "tauri",
          appVersion: "1.2.3",
          locale: "zh-CN",
          firstLaunch: true,
        },
      }),
      expect.objectContaining({
        name: "app.screen.viewed",
        category: "app",
        attributes: { route: "/settings/observability" },
      }),
    ])
  })

  it("honours the app category switch independently of the master switch", async () => {
    localStorage.setItem(
      BEHAVIOR_TELEMETRY_STORAGE_KEY,
      JSON.stringify({ enabled: true, categories: { app: false } })
    )
    await expect(trackScreenViewed("/memory")).resolves.toBe(false)
    expect(exported).toEqual([])
  })
})
