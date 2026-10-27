import {
  __resetSandboxRuntimeAvailabilityForTesting,
  projectSandboxRuntimeAvailability,
  projectSandboxConnectionCapabilities,
} from "./runtime-availability"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import type { SandboxConnectionRow } from "@/types/sandbox"

afterEach(__resetSandboxRuntimeAvailabilityForTesting)

it("keeps Lume recovery available while feature, helper and GUI gates stay independent", () => {
  const row = connection({
    provider: "lume",
    driver: "cua-driver",
    config: {
      provider: "lume",
      vmName: "owned",
      contractVersion: 1,
      resourceId: "r",
      generation: 1,
      bootEpoch: "boot",
      featureEnabled: false,
      quarantine: true,
    },
    capabilities: defaultSandboxCapabilities("lume", "cua-driver"),
  })
  expect(projectSandboxConnectionCapabilities(row, true)).toMatchObject({
    health: true,
    stop: true,
    delete: true,
    start: false,
    gui: false,
    workspaceExec: false,
  })
  row.config = {
    ...row.config,
    provider: "lume",
    vmName: "owned",
    featureEnabled: true,
    quarantine: false,
    readiness: { vm: true, ssh: true, helper: true, gui: false },
  }
  expect(projectSandboxConnectionCapabilities(row, true)).toMatchObject({
    start: true,
    workspaceRead: true,
    workspaceExec: true,
    gui: false,
  })
  expect(projectSandboxConnectionCapabilities(row, false).stop).toBe(false)
})

it("projects OS from active confinement and microVM from the accepting adapter", () => {
  const available = projectSandboxRuntimeAvailability(
    { confined: true, backend: "macos-sandbox-exec", detail: "ok" },
    true
  )
  expect(available.os).toMatchObject({
    available: true,
    backend: "macos-sandbox-exec",
    reason: "available",
  })
  expect(available.microvm).toMatchObject({
    available: true,
    requiresWorkspace: true,
    reason: "workspace-required",
  })
})

it("keeps both tiers unavailable when their live proof is missing", () => {
  const unavailable = projectSandboxRuntimeAvailability(
    { confined: false, backend: "linux-bwrap", detail: "probe failed" },
    false
  )
  expect(unavailable.os).toMatchObject({ available: false, reason: "probe-failed" })
  expect(unavailable.microvm).toMatchObject({ available: false, reason: "adapter-missing" })
})

it("offers the container tier only where a Host's sandbox pool adapter runs it", () => {
  const status = { confined: true, backend: "linux-bwrap", detail: "" }
  // Every desktop and paired client: the tier is an always-on Host's.
  expect(projectSandboxRuntimeAvailability(status, false).container).toMatchObject({
    available: false,
    reason: "always-on-host-only",
  })
  expect(projectSandboxRuntimeAvailability(status, false, true).container).toMatchObject({
    available: true,
    reason: "workspace-required",
    requiresWorkspace: true,
  })
})

function connection(overrides: Partial<SandboxConnectionRow> = {}): SandboxConnectionRow {
  return {
    id: "conn",
    name: "sandbox",
    provider: "docker",
    driver: "computer-server",
    config: { provider: "docker", image: "image", host: "127.0.0.1", port: 0 },
    state: "stopped",
    capabilities: defaultSandboxCapabilities("docker", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

it("projects connection actions from the live implemented adapter", () => {
  const docker = projectSandboxConnectionCapabilities(connection(), true)
  expect(docker).toMatchObject({ start: true, stop: true, health: true, delete: true, gui: true })
  expect(projectSandboxConnectionCapabilities(connection(), false).start).toBe(false)

  const cloud = connection({
    provider: "cua-cloud",
    config: { provider: "cua-cloud", instanceName: "desk", host: "cloud.example", port: 443 },
    capabilities: { ...defaultSandboxCapabilities("docker", "computer-server") },
  })
  expect(
    Object.values(projectSandboxConnectionCapabilities(cloud, true)).every((value) => !value)
  ).toBe(true)
})

it("does not infer allowlist support from filesystem confinement or a microVM adapter", () => {
  const status = { confined: true, backend: "linux-bwrap", detail: "ok" }
  expect(projectSandboxRuntimeAvailability(status, true).os.networkAllowlist).toEqual({
    state: "unknown",
    detail: "",
  })
  const networkAllowlist = { state: "unavailable" as const, detail: "bridge missing" }
  expect(projectSandboxRuntimeAvailability({ ...status, networkAllowlist }, true).os).toMatchObject(
    { available: true, networkAllowlist }
  )
})

it("withholds unqualified E2B creation but retains cleanup and health", () => {
  const row = connection({
    provider: "e2b",
    config: {
      provider: "e2b",
      target: { kind: "remote", hostId: "host" },
      providerConfigId: "byo",
      qualification: "unqualified",
    },
    capabilities: defaultSandboxCapabilities("e2b", "computer-server"),
  })
  expect(projectSandboxConnectionCapabilities(row, true)).toMatchObject({
    create: false,
    connect: true,
    health: true,
    delete: true,
    gui: false,
    workspaceExec: false,
  })
})

it.each([undefined, 0, 1, 2, 3])(
  "projects E2B evidence version %s without widening dormant operations",
  (version) => {
    const row = connection({
      provider: "e2b",
      config: {
        provider: "e2b",
        target: { kind: "local" },
        providerConfigId: "byo",
        qualification: "qualified",
        qualificationEvidenceVersion: version,
        workloadIsolationRevision: 1,
        egressEnforcement: "provider-and-guest-kernel",
      },
      capabilities: defaultSandboxCapabilities("e2b", "computer-server"),
    })
    expect(projectSandboxConnectionCapabilities(row, true)).toMatchObject({
      create: version === 2,
      connect: true,
      health: true,
      delete: true,
      gui: false,
      workspaceRead: false,
      workspaceExec: false,
      suspend: false,
      resume: false,
    })
  }
)
