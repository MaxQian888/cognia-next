import type { DockerSandboxConfig, SandboxConnectionRow } from "@/types/sandbox"
import { sandboxClient } from "@/lib/automation/sandbox-client"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import {
  buildDockerSandboxAdapter,
  lifecycleStateFromDocker,
  policyInputFromConfig,
  requireDockerConfig,
  type DockerAdapterOutcome,
} from "./docker-adapter"
import { SandboxCapabilityError } from "./lifecycle-contract"

function config(overrides: Partial<DockerSandboxConfig> = {}): DockerSandboxConfig {
  return { image: "image", host: "127.0.0.1", port: 0, ...overrides }
}

function row(overrides: Partial<SandboxConnectionRow> = {}): SandboxConnectionRow {
  return {
    id: "conn-1",
    name: "desktop",
    provider: "docker",
    driver: "computer-server",
    config: { provider: "docker", ...config() },
    state: "uninitialized",
    capabilities: defaultSandboxCapabilities("docker", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("lifecycleStateFromDocker", () => {
  it("maps a paused container to suspended, not stopped", () => {
    // These are different machines to a user. Suspend exists precisely because
    // the session survives it, and calling that stopped would erase the only
    // difference that matters.
    expect(lifecycleStateFromDocker("paused")).toBe("suspended")
  })

  it("maps a created container to stopped", () => {
    // It exists and has run nothing, which is what stopped means here.
    expect(lifecycleStateFromDocker("created")).toBe("stopped")
  })

  it.each([
    ["running", "running"],
    ["restarting", "starting"],
    ["removing", "deleting"],
    ["exited", "stopped"],
    ["dead", "error"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(lifecycleStateFromDocker(status)).toBe(expected)
  })

  it("treats an unrecognised status as an error rather than guessing", () => {
    // Reporting an unknown status as running or stopped is a coin flip that
    // later surfaces as an operation refused for entirely the wrong reason.
    expect(lifecycleStateFromDocker("something-new")).toBe("error")
    expect(lifecycleStateFromDocker("")).toBe("error")
  })
})

describe("policyInputFromConfig", () => {
  it("is undefined when the row froze in no policy at all", () => {
    expect(policyInputFromConfig(config())).toBeUndefined()
  })

  it("carries every frozen container setting", () => {
    expect(
      policyInputFromConfig(
        config({
          networkMode: "none",
          cpus: "1.5",
          memoryMb: 2048,
          workspaceMount: { hostPath: "/host/ws", containerPath: "/workspace" },
        })
      )
    ).toEqual({
      networkMode: "none",
      cpus: "1.5",
      memoryMb: 2048,
      workspaceHostPath: "/host/ws",
      workspaceContainerPath: "/workspace",
    })
  })

  it("keeps a zero memory ceiling rather than dropping it as falsy", () => {
    expect(policyInputFromConfig(config({ memoryMb: 0 }))).toEqual({ memoryMb: 0 })
  })
})

describe("requireDockerConfig", () => {
  it("returns the config for a consistent Docker row", () => {
    expect(requireDockerConfig(row(), "start").image).toBe("image")
  })

  it("refuses a row whose config describes another provider", () => {
    // That config has no image, so starting the row would ask Docker to run
    // nothing at all.
    const mismatched = row({ config: { provider: "lume", vmName: "compat" } })
    expect(() => requireDockerConfig(mismatched, "start")).toThrow(SandboxCapabilityError)
    expect(() => requireDockerConfig(mismatched, "start")).toThrow(/describes lume/)
  })
})

test("a running container does not imply a usable desktop or execution channel", async () => {
  const connection = row({ state: "running" })
  const health = jest.fn().mockResolvedValue(false)
  const client = {
    ...sandboxClient,
    inspect: jest.fn().mockResolvedValue({
      containerId: "container-1",
      status: "running",
      running: true,
      paused: false,
      networkMode: "bridge",
      nanoCpus: 0,
      memoryBytes: 0,
    }),
    health,
  }
  const outcome: DockerAdapterOutcome = {}
  const adapter = buildDockerSandboxAdapter(connection, client, outcome, "health")
  const report = await adapter.health!({
    connectionId: connection.id,
    provider: connection.provider,
    driver: connection.driver,
    capabilities: connection.capabilities,
    state: connection.state,
  })
  expect(health).toHaveBeenCalledWith(connection.id)
  expect(report).toMatchObject({ reachable: false, state: "running" })
  expect(report.error).toContain("desktop capture")
  expect(outcome.health).toBe(false)
})
