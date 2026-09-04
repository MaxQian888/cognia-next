import {
  DEFAULT_UPDATE_CENTER_SETTINGS,
  type UpdateCandidate,
  type UpdateCenterSettings,
} from "@cognia/agent-config-types"

import type { UpdateAdapter, UpdateApplyResult } from "./adapter"
import {
  CRITICAL_DEFER_MS,
  DEFAULT_DEFER_MS,
  UpdateCoordinator,
  type CoordinatorDeps,
} from "./coordinator"

function candidate(overrides: Partial<UpdateCandidate> = {}): UpdateCandidate {
  return {
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    currentVersion: "1.0.0",
    targetVersion: "1.1.0",
    channel: "stable",
    criticality: "routine",
    source: "catalog",
    provenance: "verified",
    ...overrides,
  }
}

function stubAdapter(
  overrides: Partial<UpdateAdapter> & {
    candidates?: UpdateCandidate[]
    result?: UpdateApplyResult
  } = {}
): UpdateAdapter & { applyCalls: UpdateCandidate[] } {
  const applyCalls: UpdateCandidate[] = []
  return {
    kind: overrides.kind ?? "desktop",
    executor: overrides.executor ?? "tauri",
    isSupported: overrides.isSupported ?? (() => true),
    check: overrides.check ?? (async () => overrides.candidates ?? []),
    apply:
      overrides.apply ??
      (async (c) => {
        applyCalls.push(c)
        return overrides.result ?? { state: "verified" }
      }),
    applyCalls,
  }
}

function makeCoordinator(
  adapters: UpdateAdapter[],
  overrides: Partial<CoordinatorDeps> = {}
): { coordinator: UpdateCoordinator; settings: UpdateCenterSettings } {
  const settings: UpdateCenterSettings = {
    ...DEFAULT_UPDATE_CENTER_SETTINGS,
    rolloutBucket: 0,
    snapshots: {},
  }
  const coordinator = new UpdateCoordinator({
    adapters,
    persistence: {
      read: () => settings,
      write: async (patch) => {
        Object.assign(settings, patch)
      },
    },
    fetchCatalog: async () => ({ entries: [] }),
    random: () => 0,
    appVersion: "1.0.0",
    ...overrides,
  })
  return { coordinator, settings }
}

describe("check", () => {
  it("projects an adapter candidate into an actionable row", async () => {
    const { coordinator } = makeCoordinator([stubAdapter({ candidates: [candidate()] })])
    const items = await coordinator.check({ manual: true })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: "desktop:app",
      state: "available",
      action: "install-in-app",
      externallyInstalled: false,
    })
  })

  it("labels a store-installed row as externally installed", async () => {
    const adapter = stubAdapter({
      kind: "mobile-ios",
      executor: "app-store",
      candidates: [candidate({ kind: "mobile-ios", executor: "app-store" })],
    })
    const { coordinator } = makeCoordinator([adapter])
    const [item] = await coordinator.check({ manual: true })
    expect(item.externallyInstalled).toBe(true)
    expect(item.action).toBe("open-store")
  })

  it("honors a per-candidate action override", async () => {
    const { coordinator } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ action: "open-store" })] }),
    ])
    const [item] = await coordinator.check({ manual: true })
    expect(item.action).toBe("open-store")
  })

  it("shares one sweep between concurrent callers", async () => {
    let checks = 0
    const adapter = stubAdapter({
      check: async () => {
        checks += 1
        await new Promise((r) => setTimeout(r, 5))
        return [candidate()]
      },
    })
    const { coordinator } = makeCoordinator([adapter])
    await Promise.all([coordinator.check(), coordinator.check(), coordinator.check()])
    expect(checks).toBe(1)
  })

  it("skips an adapter the host does not support", async () => {
    const adapter = stubAdapter({ isSupported: () => false, candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    expect(await coordinator.check({ manual: true })).toHaveLength(0)
  })

  it("holds a candidate outside the rollout window", async () => {
    const { coordinator, settings } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ rollout: { percentage: 1 } })] }),
    ])
    settings.rolloutBucket = 5000
    const [item] = await coordinator.check({ manual: false })
    expect(item.state).toBe("current")
  })

  it("lets a manual check bypass the rollout percentage", async () => {
    const { coordinator, settings } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ rollout: { percentage: 1 } })] }),
    ])
    settings.rolloutBucket = 5000
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("available")
  })

  it("fails a catalog candidate whose provenance is not verified", async () => {
    const { coordinator } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ provenance: "revoked" })] }),
    ])
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("failed")
    expect(item.failure?.kind).toBe("revoked")
    expect(item.candidate).toBeNull()
  })

  it("records a classified failure and backs the asset off", async () => {
    const adapter = stubAdapter({
      check: async () => {
        throw new Error("network unreachable")
      },
    })
    const { coordinator, settings } = makeCoordinator([adapter])
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("failed")
    expect(item.failure?.kind).toBe("network")
    expect(settings.snapshots?.["desktop:desktop"]?.nextCheckAt).toBeGreaterThan(0)
  })

  it("returns a row to current when the adapter stops reporting it", async () => {
    let offer = true
    const adapter = stubAdapter({ check: async () => (offer ? [candidate()] : []) })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    offer = false
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("current")
    expect(item.candidate).toBeNull()
  })
})

describe("consent", () => {
  it("installs a routine desktop package without a separate confirmation", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const item = await coordinator.apply("desktop:app", { consented: true })
    expect(item.state).toBe("verified")
    expect(adapter.applyCalls).toHaveLength(1)
  })

  it("stops at awaiting-consent when permissions widen", async () => {
    const adapter = stubAdapter({
      kind: "plugin",
      executor: "plugin-runtime",
      candidates: [
        candidate({ kind: "plugin", executor: "plugin-runtime", permissionsExpanded: true }),
      ],
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const item = await coordinator.apply("plugin:app", { consented: false })
    expect(item.state).toBe("awaiting-consent")
    expect(item.action).toBe("review-permissions")
    expect(adapter.applyCalls).toHaveLength(0)
  })

  it("always asks before a skill content change", async () => {
    const adapter = stubAdapter({
      kind: "skill",
      executor: "skill-runtime",
      candidates: [candidate({ kind: "skill", executor: "skill-runtime" })],
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    expect((await coordinator.apply("skill:app", { consented: false })).state).toBe(
      "awaiting-consent"
    )
  })

  it("always asks before a CLI update", async () => {
    const adapter = stubAdapter({
      kind: "cli",
      executor: "package-manager",
      candidates: [candidate({ kind: "cli", executor: "package-manager" })],
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    expect((await coordinator.apply("cli:app", { consented: false })).state).toBe(
      "awaiting-consent"
    )
  })

  it("background-downloads only the first-party desktop package", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator, settings } = makeCoordinator([adapter])
    settings.backgroundDownloadDesktop = true
    await coordinator.check({ manual: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(adapter.applyCalls).toHaveLength(1)
  })

  it("does not background-download a version that widens permissions", async () => {
    const adapter = stubAdapter({ candidates: [candidate({ permissionsExpanded: true })] })
    const { coordinator, settings } = makeCoordinator([adapter])
    settings.backgroundDownloadDesktop = true
    await coordinator.check({ manual: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(adapter.applyCalls).toHaveLength(0)
  })
})

describe("skip and defer", () => {
  it("hides a skipped version on the next check", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    expect(await coordinator.skip("desktop:app")).toBe(true)
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("current")
  })

  it("refuses to skip a critical update", async () => {
    const { coordinator } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ criticality: "critical" })] }),
    ])
    await coordinator.check({ manual: true })
    expect(await coordinator.skip("desktop:app")).toBe(false)
    expect(coordinator.getItem("desktop:app")?.state).toBe("available")
  })

  it("still offers a critical update that was previously skipped at another level", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    await coordinator.skip("desktop:app")
    adapter.check = async () => [candidate({ criticality: "critical" })]
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("available")
  })

  it("brings a critical update back sooner than a routine one", async () => {
    let now = 1_000_000
    const adapter = stubAdapter({ candidates: [candidate({ criticality: "critical" })] })
    const { coordinator, settings } = makeCoordinator([adapter], { now: () => now })
    await coordinator.check({ manual: true })
    await coordinator.defer("desktop:app")
    expect(settings.snapshots?.["desktop:app"]?.deferredUntil).toBe(now + CRITICAL_DEFER_MS)

    const routine = stubAdapter({ candidates: [candidate()] })
    const second = makeCoordinator([routine], { now: () => now })
    await second.coordinator.check({ manual: true })
    await second.coordinator.defer("desktop:app")
    expect(second.settings.snapshots?.["desktop:app"]?.deferredUntil).toBe(now + DEFAULT_DEFER_MS)
    now += 1
  })

  it("keeps a deferred row hidden until its window passes", async () => {
    let now = 1_000_000
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter], { now: () => now })
    await coordinator.check({ manual: true })
    await coordinator.defer("desktop:app")
    let [item] = await coordinator.check({ manual: false })
    expect(item.state).toBe("deferred")
    now += DEFAULT_DEFER_MS + 1
    ;[item] = await coordinator.check({ manual: false })
    expect(item.state).toBe("available")
  })

  it("shows a deferred row again on a manual check", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    await coordinator.defer("desktop:app")
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("available")
  })

  it("clears a hold on request", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    await coordinator.skip("desktop:app")
    await coordinator.clearHold("desktop:app")
    const [item] = await coordinator.check({ manual: false })
    expect(item.state).toBe("available")
  })
})

describe("attempt persistence and restore", () => {
  it("writes the attempt record before any bytes move", async () => {
    const writes: string[] = []
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: async () => {
        writes.push("install")
        return { state: "awaiting-restart" }
      },
    })
    const { coordinator, settings } = makeCoordinator([adapter], {
      persistence: {
        read: () => ({ ...DEFAULT_UPDATE_CENTER_SETTINGS, rolloutBucket: 0, snapshots: {} }),
        write: async () => {
          writes.push("persist")
        },
      },
    })
    void settings
    await coordinator.check({ manual: true })
    writes.length = 0
    await coordinator.apply("desktop:app", { consented: true })
    expect(writes[0]).toBe("persist")
    expect(writes).toContain("install")
    expect(writes.indexOf("persist")).toBeLessThan(writes.indexOf("install"))
  })

  it("verifies an interrupted desktop install against the running version", async () => {
    const snapshots = {
      "desktop:app": {
        assetId: "app",
        kind: "desktop" as const,
        state: "installing" as const,
        attemptId: "att-1",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        startedAt: 1,
      },
    }
    const settings = { ...DEFAULT_UPDATE_CENTER_SETTINGS, snapshots }
    const coordinator = new UpdateCoordinator({
      adapters: [stubAdapter()],
      persistence: { read: () => settings, write: async () => {} },
      fetchCatalog: async () => null,
      appVersion: "1.1.0",
    })
    await coordinator.restore()
    expect(coordinator.getItem("desktop:app")?.state).toBe("verified")
  })

  it("reports an interrupted install as failed when the old version still runs", async () => {
    const snapshots = {
      "desktop:app": {
        assetId: "app",
        kind: "desktop" as const,
        state: "installing" as const,
        attemptId: "att-1",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
      },
    }
    const settings = { ...DEFAULT_UPDATE_CENTER_SETTINGS, snapshots }
    const coordinator = new UpdateCoordinator({
      adapters: [stubAdapter()],
      persistence: { read: () => settings, write: async () => {} },
      fetchCatalog: async () => null,
      appVersion: "1.0.0",
    })
    await coordinator.restore()
    const item = coordinator.getItem("desktop:app")
    expect(item?.state).toBe("failed")
    expect(item?.failure?.code).toBe("install_interrupted")
  })

  it("does not reinterpret a store handoff as an interrupted install", async () => {
    const snapshots = {
      "mobile-ios:app": {
        assetId: "app",
        kind: "mobile-ios" as const,
        state: "awaiting-store" as const,
        targetVersion: "2.0.0",
      },
    }
    const settings = { ...DEFAULT_UPDATE_CENTER_SETTINGS, snapshots }
    const coordinator = new UpdateCoordinator({
      adapters: [stubAdapter({ kind: "mobile-ios", executor: "app-store" })],
      persistence: { read: () => settings, write: async () => {} },
      fetchCatalog: async () => null,
      appVersion: "1.0.0",
    })
    await coordinator.restore()
    expect(coordinator.getItem("mobile-ios:app")?.state).toBe("awaiting-store")
  })
})

describe("telemetry", () => {
  it("never carries release notes or URLs", async () => {
    const events: Record<string, unknown>[] = []
    const adapter = stubAdapter({
      candidates: [candidate({ releaseNotes: "secret", externalUrl: "https://x.test" })],
    })
    const { coordinator } = makeCoordinator([adapter], {
      telemetry: (event) => events.push(event as unknown as Record<string, unknown>),
    })
    await coordinator.check({ manual: true })
    await coordinator.apply("desktop:app", { consented: true })
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain("secret")
      expect(JSON.stringify(event)).not.toContain("x.test")
    }
  })

  it("reports a store handoff as handed-off, not as success", async () => {
    const events: { outcome?: string }[] = []
    const adapter = stubAdapter({
      kind: "mobile-android",
      executor: "google-play",
      candidates: [candidate({ kind: "mobile-android", executor: "google-play" })],
      result: { state: "awaiting-store" },
    })
    const { coordinator } = makeCoordinator([adapter], {
      telemetry: (event) => events.push(event),
    })
    await coordinator.check({ manual: true })
    await coordinator.apply("mobile-android:app", { consented: true })
    expect(events.map((e) => e.outcome)).toContain("handed-off")
  })
})

describe("failures during apply", () => {
  it("classifies a thrown install error and keeps the row recoverable", async () => {
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: async () => {
        throw new Error("no space left on device")
      },
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const item = await coordinator.apply("desktop:app", { consented: true })
    expect(item.state).toBe("failed")
    expect(item.failure?.kind).toBe("disk")
  })

  it("reports a cancellation as cancelled, not as a failure", async () => {
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: async () => {
        throw new Error("The operation was aborted")
      },
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const item = await coordinator.apply("desktop:app", { consented: true })
    expect(item.state).toBe("cancelled")
  })

  it("shares one apply between concurrent callers", async () => {
    let calls = 0
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 5))
        return { state: "verified" }
      },
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    await Promise.all([
      coordinator.apply("desktop:app", { consented: true }),
      coordinator.apply("desktop:app", { consented: true }),
    ])
    expect(calls).toBe(1)
  })
})
