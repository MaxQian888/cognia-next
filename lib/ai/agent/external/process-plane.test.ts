import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"

import {
  __setProcessPlaneDepsForTests,
  canDetectInstalledAgents,
  canStartExternalAgentProcess,
  externalAgentProcessPlane,
  PROCESS_PLANE_COMMANDS,
  PROCESS_PLANE_FEATURE,
  PROCESS_SPAWN_CAPABILITY,
} from "./process-plane"

const ALL_OPERATIONS = Object.values(PROCESS_PLANE_COMMANDS)

/**
 * Every grant the five plane commands are declared under, read from the same
 * manifest the plane reads. Spelled out rather than hard-coded so a capability
 * rename cannot leave this fixture describing a device nobody can be.
 */
const ALL_GRANTS = [
  ...new Set(
    ALL_OPERATIONS.map((name) => getCommandDescriptor(name)?.capability ?? PROCESS_SPAWN_CAPABILITY)
  ),
]

const LIMITS = {
  rpcJsonBodyBytes: 1,
  skillMaxResources: 1,
  skillMaxResourceBytes: 1,
  skillUploadChunkBytes: 1,
  mcpRequestBodyBytes: 1,
  maxConcurrentProxyCalls: 1,
}

function manifest(overrides: Partial<Record<string, unknown>> = {}): HostFeatureManifest {
  return {
    schemaVersion: 2,
    hostBuildId: "test-build",
    platform: "headless",
    generatedAt: 0,
    hostIdentity: { id: "host-1", kind: "cloud" },
    protocol: { min: 1, max: 2 },
    features: {
      [PROCESS_PLANE_FEATURE]: { version: 1, operations: [...ALL_OPERATIONS] },
    },
    operations: ALL_OPERATIONS.map((name) => ({
      name,
      feature: PROCESS_PLANE_FEATURE,
      featureVersion: 1,
      healthy: true,
    })),
    deviceGrants: [...ALL_GRANTS],
    limits: LIMITS,
    ...overrides,
  } as HostFeatureManifest
}

function snapshot(
  host?: RuntimeSnapshot["host"],
  connectionState: RuntimeSnapshot["connectionState"] = "online"
): RuntimeSnapshot {
  return { target: null, vaultState: "unlocked", connectionState, host }
}

function install(overrides: Parameters<typeof __setProcessPlaneDepsForTests>[0]): () => void {
  return __setProcessPlaneDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalProcessTable: () => false,
    getRuntimeSnapshot: () => snapshot(),
    activeHostFeatureManifest: () => null,
    ...overrides,
  })
}

describe("externalAgentProcessPlane", () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it("runs locally on a shell that has a process table", () => {
    restore = install({ hasLocalProcessTable: () => true })
    expect(externalAgentProcessPlane()).toEqual({ ok: true, via: "local" })
    expect(canStartExternalAgentProcess()).toBe(true)
  })

  it("still runs locally while that shell is driving a remote host", () => {
    // `agentInvoke` routes every plane command through Tauri `invoke` whenever
    // `isTauri()` holds, remote host or not, so the child starts HERE. Judging
    // the desktop against the remote manifest instead reported `unsupported`
    // for a spawn that would have succeeded, and disabled Connect for it.
    restore = install({
      hasLocalProcessTable: () => true,
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest({ features: {} }),
    })
    expect(externalAgentProcessPlane()).toEqual({ ok: true, via: "local" })
    expect(canStartExternalAgentProcess()).toBe(true)
  })

  it("runs on a paired host that declares the plane and granted this device", () => {
    // The case the old `isTauri()` gate got wrong: a browser, no process table
    // of its own, and a Host perfectly able to spawn for it.
    restore = install({
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest(),
    })
    expect(externalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)).toEqual({
      ok: true,
      via: "remote",
    })
    expect(canStartExternalAgentProcess()).toBe(true)
    expect(canDetectInstalledAgents()).toBe(true)
  })

  it("separates a host still handshaking from a host that cannot spawn", () => {
    restore = install({ isRemoteHostActive: () => true })
    expect(externalAgentProcessPlane()).toEqual({ ok: false, reason: "manifest-missing" })
    restore()
    restore = install({
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest({ features: {} }),
    })
    expect(externalAgentProcessPlane()).toEqual({ ok: false, reason: "unsupported" })
  })

  it("refuses per operation, so a host can ship spawn before detection", () => {
    const partial = manifest({
      features: {
        [PROCESS_PLANE_FEATURE]: { version: 1, operations: [PROCESS_PLANE_COMMANDS.spawn] },
      },
      operations: [
        {
          name: PROCESS_PLANE_COMMANDS.spawn,
          feature: PROCESS_PLANE_FEATURE,
          featureVersion: 1,
          healthy: true,
        },
      ],
    })
    restore = install({
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => partial,
    })
    expect(canStartExternalAgentProcess()).toBe(true)
    expect(canDetectInstalledAgents()).toBe(false)
  })

  it("names the missing grant instead of blaming the runtime", () => {
    // `spawn_external_agent` is declared `capability: process.spawn`, which a
    // paired device only holds through Agent Control. Without this branch the
    // UI offers a Run button the Host answers with 403.
    restore = install({
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest({ deviceGrants: ["host.observe"] }),
    })
    expect(externalAgentProcessPlane()).toEqual({ ok: false, reason: "not-granted" })
  })

  it("checks the grant each command is declared under, not process.spawn for all", () => {
    // `get_external_agent_status` is `agent.run`. Gating it on Agent Control
    // hid the status of an agent from a device the Host would have answered.
    restore = install({
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest({ deviceGrants: ["agent.run"] }),
    })
    expect(externalAgentProcessPlane(PROCESS_PLANE_COMMANDS.status)).toEqual({
      ok: true,
      via: "remote",
    })
    expect(canStartExternalAgentProcess()).toBe(false)
  })

  it("refuses detection to a device the user withheld Agent Control from", () => {
    // Detection is only nominally a read: answering it forks a `--version`
    // child per catalogued runtime. It is declared `process.spawn` for that
    // reason, and a badge is not worth handing a withheld grant back.
    restore = install({
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest({ deviceGrants: ["host.observe"] }),
    })
    expect(canDetectInstalledAgents()).toBe(false)
    expect(canStartExternalAgentProcess()).toBe(false)
  })

  it("refuses every process arm to a device holding only the read grant", () => {
    restore = install({
      getRuntimeSnapshot: () =>
        snapshot({ compatible: true, operations: [...ALL_OPERATIONS], grants: ["host.observe"] }),
    })
    expect(canDetectInstalledAgents()).toBe(false)
    expect(externalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)).toEqual({
      ok: false,
      reason: "not-granted",
    })
  })

  it("does not answer from a snapshot whose connection has dropped", () => {
    // The manifest outlives the socket. Reporting the plane reachable off a
    // stale one offers a Run button whose spawn dies at the transport.
    restore = install({
      getRuntimeSnapshot: () =>
        snapshot(
          { compatible: true, operations: [...ALL_OPERATIONS], grants: [...ALL_GRANTS] },
          "offline"
        ),
    })
    expect(externalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)).toEqual({
      ok: false,
      reason: "no-host",
    })
  })

  it("does not read absence of grants from a manifest too old to declare them", () => {
    const v1 = {
      schemaVersion: 1,
      hostBuildId: "old",
      platform: "tauri",
      generatedAt: 0,
      features: { [PROCESS_PLANE_FEATURE]: { version: 1, operations: [...ALL_OPERATIONS] } },
      limits: LIMITS,
    } as unknown as HostFeatureManifest
    restore = install({ isRemoteHostActive: () => true, activeHostFeatureManifest: () => v1 })
    expect(externalAgentProcessPlane()).toEqual({ ok: true, via: "remote" })
  })

  it("says no-host when nothing local and nothing paired can run it", () => {
    restore = install({})
    expect(externalAgentProcessPlane()).toEqual({ ok: false, reason: "no-host" })
    expect(canStartExternalAgentProcess()).toBe(false)
  })

  it("falls back to the runtime snapshot, grants included", () => {
    restore = install({
      getRuntimeSnapshot: () =>
        snapshot({
          compatible: true,
          operations: [...ALL_OPERATIONS],
          grants: [PROCESS_SPAWN_CAPABILITY],
        }),
    })
    expect(externalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)).toEqual({
      ok: true,
      via: "remote",
    })

    restore()
    restore = install({
      getRuntimeSnapshot: () =>
        snapshot({ compatible: true, operations: [...ALL_OPERATIONS], grants: [] }),
    })
    expect(externalAgentProcessPlane()).toEqual({ ok: false, reason: "not-granted" })
  })

  it("ships a default dependency set that resolves without a shell", () => {
    // The injected-deps pattern hides its production path from every test that
    // stubs it. This one calls through the real defaults: in the node test
    // environment there is no Tauri, no host and no paired target, so the
    // honest answer is `no-host`, and it is reached without throwing.
    expect(externalAgentProcessPlane()).toEqual({ ok: false, reason: "no-host" })
  })
})
