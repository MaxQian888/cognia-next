import {
  __resetSandboxRuntimeAvailabilityForTesting,
  projectSandboxRuntimeAvailability,
  projectSandboxConnectionCapabilities,
} from "./runtime-availability"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import type { SandboxConnectionRow } from "@/types/sandbox"

afterEach(__resetSandboxRuntimeAvailabilityForTesting)

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
