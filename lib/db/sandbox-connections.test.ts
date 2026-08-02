/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  createSandboxConnectionRow,
  putSandboxConnection,
  listSandboxConnections,
  listSandboxConnectionsByProvider,
  getSandboxConnection,
  deleteSandboxConnection,
  updateSandboxConnectionState,
  type SandboxConnectionRow,
} from "@/lib/db/sandbox-connections"
import { defaultSandboxCapabilities } from "@/lib/sandbox/connection-capabilities"

/** A pre-v143 Docker row, exactly as an un-migrated database holds it. */
const legacy = {
  id: "conn-1",
  name: "home-docker",
  provider: "docker",
  image: "ghcr.io/trycua/cua-xfce:latest",
  host: "127.0.0.1",
  port: 49201,
  containerId: "abc123",
  lastHealthStatus: "ok",
  createdAt: 1,
  updatedAt: 1,
} as unknown as SandboxConnectionRow

function dockerRow(overrides: Partial<SandboxConnectionRow> = {}): SandboxConnectionRow {
  return {
    ...createSandboxConnectionRow({
      id: "conn-1",
      name: "home-docker",
      driver: "computer-server",
      config: { provider: "docker", image: "img:1", host: "127.0.0.1", port: 0 },
      now: 1,
    }),
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().sandboxConnections.clear()
})

describe("round-trip", () => {
  test("put + list + get + delete", async () => {
    await putSandboxConnection(dockerRow())
    expect(await listSandboxConnections()).toHaveLength(1)
    expect((await getSandboxConnection("conn-1"))?.name).toBe("home-docker")
    await deleteSandboxConnection("conn-1")
    expect(await getSandboxConnection("conn-1")).toBeUndefined()
  })

  test("list sorts newest-first by createdAt", async () => {
    await putSandboxConnection(dockerRow({ id: "a", createdAt: 1 }))
    await putSandboxConnection(dockerRow({ id: "b", createdAt: 2 }))
    expect((await listSandboxConnections()).map((r) => r.id)).toEqual(["b", "a"])
  })

  test("get returns undefined for an unknown id", async () => {
    expect(await getSandboxConnection("nope")).toBeUndefined()
  })
})

describe("legacy rows", () => {
  test("a pre-v143 row is migrated on read", async () => {
    await getDb().sandboxConnections.put(legacy)
    const row = await getSandboxConnection("conn-1")
    expect(row).toMatchObject({
      provider: "docker",
      driver: "computer-server",
      state: "running",
      config: {
        provider: "docker",
        image: "ghcr.io/trycua/cua-xfce:latest",
        host: "127.0.0.1",
        port: 49201,
        containerId: "abc123",
      },
    })
    expect(row?.capabilities).toEqual(defaultSandboxCapabilities("docker", "computer-server"))
  })

  test("listing migrates every row", async () => {
    await getDb().sandboxConnections.bulkPut([legacy, { ...legacy, id: "conn-2" }])
    for (const row of await listSandboxConnections()) {
      expect(row.config.provider).toBe("docker")
      expect(row.state).toBeDefined()
    }
  })

  test("reading does not write the migration back", async () => {
    await getDb().sandboxConnections.put(legacy)
    await getSandboxConnection("conn-1")
    const raw = (await getDb().sandboxConnections.get("conn-1")) as unknown as Record<
      string,
      unknown
    >
    expect(raw.config).toBeUndefined()
  })
})

describe("legacy mirrors on write", () => {
  test("a docker row dual-writes image/host/port for downgrade", async () => {
    await putSandboxConnection(
      dockerRow({
        config: { provider: "docker", image: "new:tag", host: "10.0.0.5", port: 9000 },
      })
    )
    const raw = (await getDb().sandboxConnections.get("conn-1")) as unknown as Record<
      string,
      unknown
    >
    expect(raw.image).toBe("new:tag")
    expect(raw.host).toBe("10.0.0.5")
    expect(raw.port).toBe(9000)
  })

  test("a cloud row writes no docker mirrors", async () => {
    await putSandboxConnection(
      createSandboxConnectionRow({
        id: "cloud-1",
        name: "cloud",
        driver: "cua-driver",
        config: { provider: "cua-cloud", instanceName: "desk-1" },
        now: 5,
      })
    )
    const raw = (await getDb().sandboxConnections.get("cloud-1")) as unknown as Record<
      string,
      unknown
    >
    expect(raw.image).toBeUndefined()
    expect(raw.host).toBeUndefined()
    expect(raw.port).toBeUndefined()
  })
})

describe("createSandboxConnectionRow", () => {
  test("starts uninitialized with the provider/driver capability matrix", () => {
    const row = createSandboxConnectionRow({
      id: "c",
      name: "lume-vm",
      driver: "cua-driver",
      config: { provider: "lume", vmName: "vm-1" },
      now: 42,
    })
    expect(row).toMatchObject({
      provider: "lume",
      driver: "cua-driver",
      state: "uninitialized",
      lastHealthStatus: "unknown",
      createdAt: 42,
      updatedAt: 42,
    })
    expect(row.capabilities).toEqual(defaultSandboxCapabilities("lume", "cua-driver"))
  })

  test("carries a credential reference but never a secret", () => {
    const row = createSandboxConnectionRow({
      id: "c",
      name: "cloud",
      driver: "cua-driver",
      config: { provider: "cua-cloud", instanceName: "desk-1" },
      credentialRef: { keyringService: "cognia.cua", keyringAccount: "default" },
      now: 1,
    })
    expect(row.credentialRef).toEqual({
      keyringService: "cognia.cua",
      keyringAccount: "default",
    })
    expect(JSON.stringify(row)).not.toMatch(/token|secret|apiKey/i)
  })

  test("omits credentialRef when not supplied", () => {
    expect(
      createSandboxConnectionRow({
        id: "c",
        name: "d",
        driver: "computer-server",
        config: { provider: "docker", image: "i", host: "h", port: 0 },
        now: 1,
      })
    ).not.toHaveProperty("credentialRef")
  })
})

describe("listSandboxConnectionsByProvider", () => {
  test("filters to one provider", async () => {
    await putSandboxConnection(dockerRow({ id: "d1", createdAt: 1 }))
    await putSandboxConnection(
      createSandboxConnectionRow({
        id: "c1",
        name: "cloud",
        driver: "cua-driver",
        config: { provider: "cua-cloud", instanceName: "x" },
        now: 2,
      })
    )
    expect((await listSandboxConnectionsByProvider("docker")).map((r) => r.id)).toEqual(["d1"])
    expect((await listSandboxConnectionsByProvider("cua-cloud")).map((r) => r.id)).toEqual(["c1"])
    expect(await listSandboxConnectionsByProvider("lume")).toEqual([])
  })
})

describe("updateSandboxConnectionState", () => {
  test("patches state and bumps updatedAt", async () => {
    await putSandboxConnection(dockerRow())
    const next = await updateSandboxConnectionState("conn-1", { state: "running", now: 99 })
    expect(next).toMatchObject({ state: "running", updatedAt: 99 })
    expect((await getSandboxConnection("conn-1"))?.state).toBe("running")
  })

  test("stores the config the provider handed back", async () => {
    await putSandboxConnection(dockerRow())
    await updateSandboxConnectionState("conn-1", {
      config: {
        provider: "docker",
        image: "img:1",
        host: "127.0.0.1",
        port: 51000,
        containerId: "z",
      },
      now: 2,
    })
    expect((await getSandboxConnection("conn-1"))?.config).toMatchObject({
      port: 51000,
      containerId: "z",
    })
  })

  test("narrows capabilities when the handshake reports less", async () => {
    await putSandboxConnection(dockerRow())
    const narrowed = { ...dockerRow().capabilities, gui: false }
    await updateSandboxConnectionState("conn-1", { capabilities: narrowed, now: 2 })
    expect((await getSandboxConnection("conn-1"))?.capabilities.gui).toBe(false)
  })

  test("records a health failure and then clears it with null", async () => {
    await putSandboxConnection(dockerRow())
    await updateSandboxConnectionState("conn-1", {
      lastHealthStatus: "unreachable",
      lastHealthError: "connection refused",
      lastHealthCheckAt: 10,
      now: 10,
    })
    expect(await getSandboxConnection("conn-1")).toMatchObject({
      lastHealthStatus: "unreachable",
      lastHealthError: "connection refused",
      lastHealthCheckAt: 10,
    })

    await updateSandboxConnectionState("conn-1", {
      lastHealthStatus: "ok",
      lastHealthError: null,
      now: 11,
    })
    const healed = await getSandboxConnection("conn-1")
    expect(healed?.lastHealthStatus).toBe("ok")
    expect(healed).not.toHaveProperty("lastHealthError")
  })

  test("leaves an existing error alone when lastHealthError is omitted", async () => {
    await putSandboxConnection(dockerRow())
    await updateSandboxConnectionState("conn-1", { lastHealthError: "boom", now: 1 })
    await updateSandboxConnectionState("conn-1", { state: "stopping", now: 2 })
    expect((await getSandboxConnection("conn-1"))?.lastHealthError).toBe("boom")
  })

  test("returns undefined and writes nothing when the row was deleted mid-transition", async () => {
    expect(await updateSandboxConnectionState("gone", { state: "running", now: 1 })).toBeUndefined()
    expect(await getSandboxConnection("gone")).toBeUndefined()
  })

  test("migrates a legacy row before patching it", async () => {
    await getDb().sandboxConnections.put(legacy)
    const next = await updateSandboxConnectionState("conn-1", { state: "stopped", now: 7 })
    expect(next).toMatchObject({ state: "stopped", config: { provider: "docker" } })
  })
})
