/** @jest-environment jsdom */
import { createMobileAdapter } from "./mobile-adapter"
import type { CatalogEntry } from "../catalog-types"
import { DEFAULT_UPDATE_CENTER_SETTINGS } from "@cognia/agent-config-types"
import { UpdateCoordinator } from "../coordinator"

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
      storeUrls: { ios: "https://apps.apple.com/app/id123456789" },
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

it("does not invent an iOS store listing when no distribution URL is configured", async () => {
  const openExternal = jest.fn()
  const adapter = createMobileAdapter("mobile-ios", { appVersion: "1.0.0", openExternal })
  const [candidate] = await adapter.check({ ...CONTEXT, catalog: [entry()] })
  expect(candidate.externalUrl).toBeUndefined()
  expect(await adapter.apply(candidate, { consented: true })).toMatchObject({
    state: "failed",
    failure: { code: "store_url_missing" },
  })
  expect(openExternal).not.toHaveBeenCalled()
})

it("uses a signed-catalog Android distribution URL without forcing Play", async () => {
  const openExternal = jest.fn()
  const startFlexibleUpdate = jest.fn()
  const openAppStore = jest.fn()
  const adapter = createMobileAdapter("mobile-android", {
    appVersion: "1.0.0",
    openExternal,
    playCore: playCore({
      getAppUpdateInfo: async () => ({ kind: "unsupported" }),
      startFlexibleUpdate,
      openAppStore,
    }),
  })
  const [candidate] = await adapter.check({
    ...CONTEXT,
    catalog: [
      entry({
        kind: "mobile-android",
        executor: "google-play",
        externalUrl: "https://downloads.example/cognia.apk",
      }),
    ],
  })
  await adapter.apply(candidate, { consented: true })
  expect(openExternal).toHaveBeenCalledWith("https://downloads.example/cognia.apk")
  expect(startFlexibleUpdate).not.toHaveBeenCalled()
  expect(openAppStore).not.toHaveBeenCalled()
})

it("skips Play APIs when the device has no Google Play services", async () => {
  const getAppUpdateInfo = jest.fn()
  const openExternal = jest.fn()
  const adapter = createMobileAdapter("mobile-android", {
    appVersion: "1.0.0",
    playAvailable: async () => false,
    playCore: playCore({ getAppUpdateInfo }),
    openExternal,
  })
  const [candidate] = await adapter.check({
    ...CONTEXT,
    catalog: [
      entry({
        kind: "mobile-android",
        executor: "google-play",
        externalUrl: "https://downloads.example/cognia.apk",
      }),
    ],
  })
  await adapter.apply(candidate, { consented: true })
  expect(getAppUpdateInfo).not.toHaveBeenCalled()
  expect(openExternal).toHaveBeenCalledWith("https://downloads.example/cognia.apk")
})

describe("current Play capability and download readiness", () => {
  it("routes downloaded installation through the coordinator's explicit consent action", async () => {
    const completeFlexibleUpdate = jest.fn(async () => true)
    const adapter = createMobileAdapter("mobile-android", {
      isNativeMobile: () => true,
      osFamily: () => "android",
      playCore: playCore({
        getAppUpdateInfo: async () => ({
          kind: "ok",
          value: { availability: "available", downloaded: true, availableVersionCode: "200" },
        }),
        completeFlexibleUpdate,
      }),
    })
    const settings = { ...DEFAULT_UPDATE_CENTER_SETTINGS, rolloutBucket: 0, snapshots: {} }
    const coordinator = new UpdateCoordinator({
      adapters: [adapter],
      persistence: {
        read: () => settings,
        write: async (patch) => {
          Object.assign(settings, patch)
        },
      },
      fetchCatalog: async () => ({ entries: [] }),
      random: () => 0,
      appVersion: "1.0.0",
    })
    const [row] = await coordinator.check({ manual: true })
    expect(row.action).toBe("install-in-app")
    expect((await coordinator.apply(row.key, { consented: false })).state).toBe("awaiting-consent")
    expect(completeFlexibleUpdate).not.toHaveBeenCalled()
    expect((await coordinator.apply(row.key, { consented: true })).state).toBe("awaiting-restart")
    expect(completeFlexibleUpdate).toHaveBeenCalledTimes(1)
  })
  const candidate = {
    assetId: "app",
    kind: "mobile-android" as const,
    executor: "google-play" as const,
    currentVersion: "1.0.0",
    targetVersion: "2.0.0",
    channel: "stable" as const,
    criticality: "routine" as const,
    source: "store" as const,
    provenance: "verified" as const,
    externalUrl: "https://play.google.com/store/apps/details?id=com.cognia.mobile",
  }
  function setup(info: Record<string, unknown>) {
    const startFlexibleUpdate = jest.fn(async () => "started" as const)
    const performImmediateUpdate = jest.fn(async () => "started" as const)
    const completeFlexibleUpdate = jest.fn(async () => true)
    const openAppStore = jest.fn(async () => true)
    const adapter = createMobileAdapter("mobile-android", {
      playCore: playCore({
        getAppUpdateInfo: async () => ({ kind: "ok", value: info }),
        startFlexibleUpdate,
        performImmediateUpdate,
        completeFlexibleUpdate,
        openAppStore,
      }),
    })
    return {
      adapter,
      startFlexibleUpdate,
      performImmediateUpdate,
      completeFlexibleUpdate,
      openAppStore,
    }
  }
  it("uses a build code when Android has no version name or catalog version", async () => {
    const { adapter } = setup({ availability: "available", availableVersionCode: "200" })
    expect((await adapter.check(CONTEXT))[0].targetVersion).toBe("200")
  })
  it("offers downloaded updates even when availability says not available", async () => {
    const { adapter, completeFlexibleUpdate } = setup({
      availability: "not-available",
      downloaded: true,
      availableVersionCode: "200",
    })
    expect((await adapter.check(CONTEXT))[0]).toMatchObject({
      action: "install-in-app",
      targetVersion: "200",
    })
    expect(completeFlexibleUpdate).not.toHaveBeenCalled()
  })
  it("completes only a downloaded update after explicit acceptance", async () => {
    const { adapter, completeFlexibleUpdate, startFlexibleUpdate } = setup({ downloaded: true })
    expect(await adapter.apply(candidate, { consented: false })).toEqual({
      state: "awaiting-consent",
    })
    expect(completeFlexibleUpdate).not.toHaveBeenCalled()
    expect(await adapter.apply(candidate, { consented: true })).toMatchObject({
      state: "awaiting-restart",
    })
    expect(completeFlexibleUpdate).toHaveBeenCalledTimes(1)
    expect(startFlexibleUpdate).not.toHaveBeenCalled()
  })
  it("keeps an unfinished download in progress without completing or restarting it", async () => {
    const { adapter, completeFlexibleUpdate, startFlexibleUpdate } = setup({
      availability: "in-progress",
      downloaded: false,
      flexibleAllowed: true,
    })
    expect(await adapter.apply(candidate, { consented: true })).toMatchObject({
      state: "awaiting-store",
    })
    expect(completeFlexibleUpdate).not.toHaveBeenCalled()
    expect(startFlexibleUpdate).not.toHaveBeenCalled()
  })
  it.each([
    [false, false, "routine", "store"],
    [false, true, "routine", "store"],
    [true, false, "critical", "flexible"],
    [false, true, "critical", "immediate"],
  ] as const)(
    "respects allowed flows flexible=%s immediate=%s criticality=%s",
    async (flexibleAllowed, immediateAllowed, criticality, flow) => {
      const f = setup({ availability: "available", flexibleAllowed, immediateAllowed })
      await f.adapter.apply({ ...candidate, criticality }, { consented: true })
      expect(f.startFlexibleUpdate).toHaveBeenCalledTimes(flow === "flexible" ? 1 : 0)
      expect(f.performImmediateUpdate).toHaveBeenCalledTimes(flow === "immediate" ? 1 : 0)
      expect(f.openAppStore).toHaveBeenCalledTimes(flow === "store" ? 1 : 0)
    }
  )
  it("never restarts an aborted operation", async () => {
    const { adapter, completeFlexibleUpdate } = setup({ downloaded: true })
    const controller = new AbortController()
    controller.abort()
    expect(await adapter.apply(candidate, { consented: true, signal: controller.signal })).toEqual({
      state: "cancelled",
    })
    expect(completeFlexibleUpdate).not.toHaveBeenCalled()
  })
})
