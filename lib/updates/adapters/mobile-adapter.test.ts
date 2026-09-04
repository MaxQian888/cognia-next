/** @jest-environment jsdom */
import { createMobileAdapter, resumePlayUpdateOnResume } from "./mobile-adapter"
import type { CatalogEntry } from "../catalog-types"

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    assetId: "app",
    kind: "mobile-ios",
    executor: "app-store",
    version: "2.0.0",
    channel: "stable",
    criticality: "routine",
    releasedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

const CONTEXT = {
  channel: "stable" as const,
  rolloutBucket: 0,
  manual: true,
  catalog: null as readonly CatalogEntry[] | null,
}

function playCore(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getAppUpdateInfo: async () => ({
      kind: "ok" as const,
      value: {
        availability: "available" as const,
        currentVersionName: "1.0.0",
        availableVersionName: "2.0.0",
        flexibleAllowed: true,
        immediateAllowed: true,
      },
    }),
    startFlexibleUpdate: async () => "started" as const,
    completeFlexibleUpdate: async () => true,
    performImmediateUpdate: async () => "started" as const,
    openAppStore: async () => true,
    ...overrides,
  } as never
}

describe("iOS", () => {
  it("is supported only on a native iOS shell", () => {
    expect(
      createMobileAdapter("mobile-ios", {
        isNativeMobile: () => true,
        osFamily: () => "ios",
      }).isSupported()
    ).toBe(true)
    expect(
      createMobileAdapter("mobile-ios", {
        isNativeMobile: () => true,
        osFamily: () => "android",
      }).isSupported()
    ).toBe(false)
  })

  it("only ever offers a store handoff", async () => {
    const opened: string[] = []
    const adapter = createMobileAdapter("mobile-ios", {
      appVersion: "1.0.0",
      openExternal: async (url) => {
        opened.push(url)
      },
    })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [entry()] })
    expect(candidate.executor).toBe("app-store")
    const result = await adapter.apply(candidate, { consented: true })
    expect(result.state).toBe("awaiting-store")
    expect(opened[0]).toContain("apps.apple.com")
  })
})

describe("Android", () => {
  it("prefers what Play reports over the catalog", async () => {
    const adapter = createMobileAdapter("mobile-android", {
      appVersion: "1.0.0",
      playCore: playCore(),
    })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [] })
    expect(candidate).toMatchObject({
      source: "store",
      currentVersion: "1.0.0",
      targetVersion: "2.0.0",
    })
  })

  it("reports nothing when Play says the device is current", async () => {
    const adapter = createMobileAdapter("mobile-android", {
      playCore: playCore({
        getAppUpdateInfo: async () => ({
          kind: "ok",
          value: { availability: "not-available", flexibleAllowed: false, immediateAllowed: false },
        }),
      }),
    })
    expect(await adapter.check({ ...CONTEXT, catalog: [] })).toEqual([])
  })

  it("falls back to the catalog when Play Core is missing", async () => {
    const adapter = createMobileAdapter("mobile-android", {
      appVersion: "1.0.0",
      playCore: playCore({ getAppUpdateInfo: async () => ({ kind: "unsupported" }) }),
    })
    const [candidate] = await adapter.check({
      ...CONTEXT,
      catalog: [entry({ kind: "mobile-android", executor: "google-play" })],
    })
    expect(candidate.source).toBe("catalog")
  })

  it("uses the background flow for a routine update", async () => {
    const calls: string[] = []
    const adapter = createMobileAdapter("mobile-android", {
      playCore: playCore({
        startFlexibleUpdate: async () => {
          calls.push("flexible")
          return "started"
        },
        performImmediateUpdate: async () => {
          calls.push("immediate")
          return "started"
        },
      }),
    })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [] })
    await adapter.apply(candidate, { consented: true })
    expect(calls).toEqual(["flexible"])
  })

  it("uses the blocking flow only for a confirmed critical update", async () => {
    const calls: string[] = []
    const adapter = createMobileAdapter("mobile-android", {
      playCore: playCore({
        startFlexibleUpdate: async () => {
          calls.push("flexible")
          return "started"
        },
        performImmediateUpdate: async () => {
          calls.push("immediate")
          return "started"
        },
      }),
    })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [] })
    await adapter.apply({ ...candidate, criticality: "critical" }, { consented: true })
    expect(calls).toEqual(["immediate"])
  })

  it("never blocks without consent, even for a critical update", async () => {
    const calls: string[] = []
    const adapter = createMobileAdapter("mobile-android", {
      playCore: playCore({
        startFlexibleUpdate: async () => {
          calls.push("flexible")
          return "started"
        },
        performImmediateUpdate: async () => {
          calls.push("immediate")
          return "started"
        },
      }),
    })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [] })
    await adapter.apply({ ...candidate, criticality: "critical" }, { consented: false })
    expect(calls).toEqual(["flexible"])
  })

  it("reports a user cancel as cancelled, not as a failure", async () => {
    const adapter = createMobileAdapter("mobile-android", {
      playCore: playCore({ startFlexibleUpdate: async () => "cancelled" }),
    })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [] })
    expect((await adapter.apply(candidate, { consented: true })).state).toBe("cancelled")
  })

  it("opens the store when the native module is absent", async () => {
    let openedStore = false
    const adapter = createMobileAdapter("mobile-android", {
      playCore: playCore({
        startFlexibleUpdate: async () => "unsupported",
        openAppStore: async () => {
          openedStore = true
          return true
        },
      }),
    })
    const [candidate] = await adapter.check({ ...CONTEXT, catalog: [] })
    const result = await adapter.apply(candidate, { consented: true })
    expect(result.state).toBe("awaiting-store")
    expect(openedStore).toBe(true)
  })
})

describe("resumePlayUpdateOnResume", () => {
  it("completes a download that finished while backgrounded", async () => {
    let completed = false
    const done = await resumePlayUpdateOnResume({
      playCore: playCore({
        getAppUpdateInfo: async () => ({
          kind: "ok",
          value: { availability: "in-progress", flexibleAllowed: true, immediateAllowed: false },
        }),
        completeFlexibleUpdate: async () => {
          completed = true
          return true
        },
      }),
    })
    expect(done).toBe(true)
    expect(completed).toBe(true)
  })

  it("does nothing when no download is in flight", async () => {
    expect(await resumePlayUpdateOnResume({ playCore: playCore() })).toBe(false)
  })

  it("does nothing off Android", async () => {
    expect(await resumePlayUpdateOnResume({})).toBe(false)
  })
})
