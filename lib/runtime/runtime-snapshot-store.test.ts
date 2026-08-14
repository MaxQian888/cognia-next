import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import {
  __resetRuntimeSnapshotForTesting,
  getRuntimeSnapshot,
  runtimeHostSnapshotFromManifest,
  setRuntimeSnapshot,
  subscribeRuntimeSnapshot,
  updateRuntimeSnapshot,
} from "./runtime-snapshot-store"

afterEach(() => {
  __resetRuntimeSnapshotForTesting()
})

it("publishes immutable runtime snapshot changes", () => {
  const listener = jest.fn()
  const unsubscribe = subscribeRuntimeSnapshot(listener)
  const target = { id: "web-standalone", kind: "standalone", platform: "web" } as const

  setRuntimeSnapshot({
    target,
    vaultState: "unlocked",
    connectionState: "online",
  })
  updateRuntimeSnapshot({ connectionState: "offline" })

  expect(listener).toHaveBeenCalledTimes(2)
  expect(getRuntimeSnapshot()).toEqual({
    target,
    vaultState: "unlocked",
    connectionState: "offline",
  })
  unsubscribe()
})

it("uses only healthy v2 operations and explicit device grants", () => {
  const manifest = buildLocalHostFeatureManifest({
    platform: "headless",
    deviceGrants: ["agent.run"],
  })
  manifest.operations[0] = { ...manifest.operations[0], healthy: false }

  expect(runtimeHostSnapshotFromManifest(manifest)).toEqual({
    compatible: true,
    operations: manifest.operations
      .filter((operation) => operation.healthy)
      .map((operation) => operation.name),
    grants: ["agent.run"],
  })
})

it("withholds HostState submit until the migration stage is authoritative", () => {
  const manifest = buildLocalHostFeatureManifest({ platform: "tauri" })
  const snapshot = runtimeHostSnapshotFromManifest(manifest, {
    hostStateWriteEnabled: false,
  })

  expect(snapshot.operations).not.toContain("host_state_submit")
  expect(snapshot.operations).toContain("host_state_snapshot")
  expect(snapshot.operations).toContain("host_state_status")
})

it("keeps v1 hosts usable by deriving grants from their advertised operations", () => {
  const v2 = buildLocalHostFeatureManifest({ platform: "tauri" })
  const v1 = {
    schemaVersion: 1 as const,
    hostBuildId: v2.hostBuildId,
    platform: v2.platform,
    generatedAt: v2.generatedAt,
    features: v2.features,
    limits: v2.limits,
  }

  const snapshot = runtimeHostSnapshotFromManifest(v1)

  expect(snapshot?.operations).toContain("claude_send")
  expect(snapshot?.grants).toContain("agent.run")
})

it("fails closed for malformed manifests", () => {
  expect(runtimeHostSnapshotFromManifest({ schemaVersion: 2 })).toEqual({
    compatible: false,
    operations: [],
    grants: [],
  })
})

it("negotiates the protocol overlap instead of treating every parsed v2 host as compatible", () => {
  const overlapping = buildLocalHostFeatureManifest({ platform: "headless" })
  overlapping.protocol = { min: 2, max: 3 }
  const incompatible = buildLocalHostFeatureManifest({ platform: "headless" })
  incompatible.protocol = { min: 3, max: 4 }

  expect(runtimeHostSnapshotFromManifest(overlapping).compatible).toBe(true)
  expect(runtimeHostSnapshotFromManifest(incompatible)).toEqual({
    compatible: false,
    operations: [],
    grants: [],
  })
})

it("excludes operations whose feature version the client does not support", () => {
  const manifest = buildLocalHostFeatureManifest({
    platform: "headless",
    deviceGrants: ["agent.run"],
  })
  manifest.features["skills.catalog"] = {
    version: 2,
    operations: ["skills_catalog_get"],
  }
  manifest.operations = manifest.operations
    .filter((operation) => operation.feature !== "skills.catalog")
    .concat({
      name: "skills_catalog_get",
      feature: "skills.catalog",
      featureVersion: 2,
      healthy: true,
    })

  const snapshot = runtimeHostSnapshotFromManifest(manifest)
  expect(snapshot.compatible).toBe(true)
  expect(snapshot.grants).toEqual(["agent.run"])
  expect(snapshot.operations).not.toContain("skills_catalog_get")
})
