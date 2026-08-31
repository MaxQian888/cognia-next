import { renderHook, act } from "@testing-library/react"
import type { SandboxConnectionRow } from "@/types/sandbox"

jest.mock("dexie-react-hooks", () => ({
  // Return the default (initialValue) synchronously. We exercise the action
  // callbacks, not the live-query reactivity.
  useLiveQuery: (_fn: unknown, _deps: unknown, initial: unknown) => initial,
}))

jest.mock("@/lib/db/sandbox-connections", () => ({
  ...jest.requireActual("@/lib/db/sandbox-connections"),
  listSandboxConnections: jest.fn().mockResolvedValue([]),
  putSandboxConnection: jest.fn(),
  deleteSandboxConnection: jest.fn().mockResolvedValue(undefined),
  getSandboxConnection: jest.fn(),
  // Stubbed rather than spread from the real module: the real implementation
  // calls its own `getSandboxConnection` / `putSandboxConnection` through
  // module-local references, which a mocked export cannot intercept, so it
  // would reach Dexie.
  updateSandboxConnectionState: jest.fn(),
}))

jest.mock("@/lib/automation/sandbox-client", () => ({
  sandboxClient: {
    create: jest.fn(),
    start: jest.fn(),
    suspend: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(),
    delete: jest.fn(),
    inspect: jest.fn(),
    health: jest.fn(),
    exec: jest.fn(),
    readFile: jest.fn(),
  },
}))

import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import * as db from "@/lib/db/sandbox-connections"
import { sandboxClient } from "@/lib/automation/sandbox-client"
import { defaultSandboxCapabilities } from "@/lib/sandbox/connection-capabilities"

const put = db.putSandboxConnection as jest.Mock
const get = db.getSandboxConnection as jest.Mock
const update = db.updateSandboxConnectionState as jest.Mock
const client = sandboxClient as unknown as Record<string, jest.Mock>

/** The one row the actions operate on, so reads see previous writes. */
let stored: SandboxConnectionRow | undefined

function dockerRow(overrides: Partial<SandboxConnectionRow> = {}): SandboxConnectionRow {
  return {
    id: "c1",
    name: "home",
    provider: "docker",
    driver: "computer-server",
    config: { provider: "docker", image: "img", host: "127.0.0.1", port: 0 },
    state: "uninitialized",
    capabilities: defaultSandboxCapabilities("docker", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function seed(row: SandboxConnectionRow | undefined) {
  stored = row
}

/** Every row written during the action, oldest first. */
function writes(): SandboxConnectionRow[] {
  return put.mock.calls.map((call) => call[0] as SandboxConnectionRow)
}

function lastWrite(): SandboxConnectionRow | undefined {
  return writes().at(-1)
}

beforeEach(() => {
  jest.clearAllMocks()
  stored = undefined

  get.mockImplementation(async () => stored)
  put.mockImplementation(async (row: SandboxConnectionRow) => {
    stored = row
  })
  update.mockImplementation(
    async (
      id: string,
      patch: Record<string, unknown>
    ): Promise<SandboxConnectionRow | undefined> => {
      const existing = stored
      if (!existing || existing.id !== id) return undefined
      const { now, lastHealthError, ...rest } = patch
      const next = { ...existing, ...rest, updatedAt: now } as SandboxConnectionRow
      if (lastHealthError === null) delete next.lastHealthError
      else if (lastHealthError !== undefined) next.lastHealthError = lastHealthError as string
      await put(next)
      return next
    }
  )

  client.create.mockResolvedValue({ containerId: "cid", port: 0 })
  client.start.mockResolvedValue({ containerId: "cid", port: 49160 })
  client.resume.mockResolvedValue({ containerId: "cid", port: 49160 })
  client.suspend.mockResolvedValue(undefined)
  client.stop.mockResolvedValue(undefined)
  client.delete.mockResolvedValue(undefined)
  client.health.mockResolvedValue(true)
  client.inspect.mockResolvedValue({
    containerId: "cid",
    status: "running",
    running: true,
    paused: false,
    networkMode: "bridge",
    nanoCpus: 0,
    memoryBytes: 0,
  })
})

test("create writes a docker row with defaults", async () => {
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.create({ name: "home" })
  })
  expect(lastWrite()).toMatchObject({
    name: "home",
    provider: "docker",
    image: "ghcr.io/trycua/cua-xfce:latest",
    host: "127.0.0.1",
    port: 0,
    lastHealthStatus: "unknown",
  })
})

test("create freezes the container policy onto the row", async () => {
  // Docker fixes network mode and the cpu/memory ceiling when the container is
  // made, so the row has to remember what was actually applied.
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.create({
      name: "confined",
      networkMode: "none",
      cpus: "1.5",
      memoryMb: 2048,
      workspaceMount: { hostPath: "/host/ws", containerPath: "/workspace" },
    })
  })
  expect(lastWrite()?.config).toMatchObject({
    networkMode: "none",
    cpus: "1.5",
    memoryMb: 2048,
    workspaceMount: { hostPath: "/host/ws", containerPath: "/workspace" },
  })
})

test("start records the placement and passes through starting", async () => {
  seed(dockerRow())
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.start("c1")
  })
  expect(client.start).toHaveBeenCalledWith("c1", "img", undefined)
  // The transitional state is written before the adapter call, so a slow
  // Docker pull is visible rather than looking like a frozen button.
  expect(writes().map((row) => row.state)).toContain("starting")
  expect(lastWrite()).toMatchObject({
    config: { provider: "docker", port: 49160, containerId: "cid" },
    state: "running",
    lastHealthStatus: "ok",
  })
})

test("provision leaves the machine created but not running", async () => {
  seed(dockerRow())
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.provision("c1")
  })
  expect(client.create).toHaveBeenCalledWith("c1", "img", undefined)
  expect(writes().map((row) => row.state)).toContain("creating")
  expect(lastWrite()).toMatchObject({
    state: "stopped",
    config: { containerId: "cid", port: 0 },
  })
})

test("suspend pauses and does not stop or delete", async () => {
  seed(
    dockerRow({
      state: "running",
      config: { provider: "docker", image: "img", host: "h", port: 1 },
    })
  )
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.suspend("c1")
  })
  expect(client.suspend).toHaveBeenCalledWith("c1")
  expect(client.stop).not.toHaveBeenCalled()
  expect(client.delete).not.toHaveBeenCalled()
  expect(lastWrite()).toMatchObject({ state: "suspended" })
  // The port mapping and everything in memory survive a pause. Clearing either
  // would describe a machine that had been stopped.
  expect(lastWrite()?.config).toMatchObject({ port: 1 })
})

test("resume returns the machine to running", async () => {
  seed(dockerRow({ state: "suspended" }))
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.resume("c1")
  })
  expect(client.resume).toHaveBeenCalledWith("c1")
  expect(writes().map((row) => row.state)).toContain("resuming")
  expect(lastWrite()).toMatchObject({ state: "running", lastHealthStatus: "ok" })
})

test("stop keeps the container id because the container survives", async () => {
  seed(
    dockerRow({
      state: "running",
      config: { provider: "docker", image: "img", host: "h", port: 49160, containerId: "cid" },
    })
  )
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.stop("c1")
  })
  expect(client.stop).toHaveBeenCalledWith("c1")
  // Docker publishes no port for a stopped container, so the port goes. The
  // container itself now outlives a stop, along with everything written inside
  // it, so dropping its id would orphan a machine the row still owns.
  expect(lastWrite()).toMatchObject({
    state: "stopped",
    config: { port: 0, containerId: "cid" },
  })
})

test("unsupported providers fail closed and do not remain starting", async () => {
  seed(
    dockerRow({
      provider: "cua-cloud",
      config: { provider: "cua-cloud", instanceName: "desk", host: "example.com", port: 443 },
      capabilities: defaultSandboxCapabilities("cua-cloud", "computer-server"),
    })
  )
  const { result } = renderHook(() => useSandboxConnections())

  await expect(result.current.start("c1")).rejects.toMatchObject({ code: "not-implemented" })

  expect(client.start).not.toHaveBeenCalled()
  expect(lastWrite()).toMatchObject({ state: "error", lastHealthStatus: "error" })
})

test("remove deletes the container, not merely stops it", async () => {
  seed(dockerRow({ state: "running" }))
  const { result } = renderHook(() => useSandboxConnections())

  await act(async () => {
    await result.current.remove("c1")
  })

  // `delete` used to call stop, which only looked right while containers were
  // created with `--rm`.
  expect(client.delete).toHaveBeenCalledWith("c1")
  expect(client.stop).not.toHaveBeenCalled()
  expect(db.deleteSandboxConnection).toHaveBeenCalledWith("c1")
})

test("a failed probe keeps the diagnostic the user asked to see", async () => {
  seed(
    dockerRow({
      state: "error",
      lastHealthStatus: "error",
      lastHealthError: "Docker daemon not reachable at unix:///var/run/docker.sock",
    })
  )
  client.inspect.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
  const { result } = renderHook(() => useSandboxConnections())

  await act(async () => {
    await result.current.refreshHealth("c1")
  })

  // Refresh is what a user reaches for when the machine is already broken, so
  // it must not blank the only message telling them what to fix.
  expect(lastWrite()).toMatchObject({
    lastHealthStatus: "unreachable",
    lastHealthError: "connect ECONNREFUSED",
  })
})

test("a probe that cannot run leaves the lifecycle state alone", async () => {
  // No evidence is not evidence the machine is stopped.
  seed(dockerRow({ state: "running" }))
  client.inspect.mockRejectedValueOnce(new Error("daemon down"))
  const { result } = renderHook(() => useSandboxConnections())

  await act(async () => {
    await result.current.refreshHealth("c1")
  })

  expect(lastWrite()).toMatchObject({ state: "running", lastHealthStatus: "unreachable" })
})

test("a probe reconciles the lifecycle state from Docker's own view", async () => {
  // The row believes it is running. Docker says the container exited. The
  // probe now has evidence, so it corrects the row instead of leaving it.
  seed(dockerRow({ state: "running" }))
  client.inspect.mockResolvedValueOnce({
    containerId: "cid",
    status: "exited",
    running: false,
    paused: false,
    networkMode: "bridge",
    nanoCpus: 0,
    memoryBytes: 0,
  })
  const { result } = renderHook(() => useSandboxConnections())

  await act(async () => {
    await result.current.refreshHealth("c1")
  })

  expect(lastWrite()).toMatchObject({ state: "stopped", lastHealthStatus: "unreachable" })
  expect(client.health).not.toHaveBeenCalled()
})

test("a probe reports a paused container as suspended", async () => {
  seed(dockerRow({ state: "running" }))
  client.inspect.mockResolvedValueOnce({
    containerId: "cid",
    status: "paused",
    running: true,
    paused: true,
    networkMode: "bridge",
    nanoCpus: 0,
    memoryBytes: 0,
  })
  const { result } = renderHook(() => useSandboxConnections())

  await act(async () => {
    await result.current.refreshHealth("c1")
  })

  expect(lastWrite()).toMatchObject({ state: "suspended" })
})

test("a healthy probe clears the stale diagnostic", async () => {
  seed(dockerRow({ state: "running", lastHealthError: "container exited with code 1" }))
  const { result } = renderHook(() => useSandboxConnections())

  await act(async () => {
    await result.current.refreshHealth("c1")
  })

  expect(lastWrite()).toMatchObject({ lastHealthStatus: "ok", state: "running" })
  expect(lastWrite()?.lastHealthError).toBeUndefined()
})
