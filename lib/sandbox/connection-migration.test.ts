import type { LegacySandboxConnectionRow, SandboxConnectionRow } from "@/types/sandbox"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import {
  LEGACY_SANDBOX_DRIVER,
  LEGACY_SANDBOX_IMAGE,
  inferLegacyLifecycleState,
  isMigratedSandboxConnection,
  migrateSandboxConnectionRow,
  migrateSandboxConnectionRows,
  syncLegacySandboxMirrors,
} from "./connection-migration"

function legacyRow(
  overrides: Partial<LegacySandboxConnectionRow> = {}
): LegacySandboxConnectionRow {
  return {
    id: "conn-1",
    name: "home-docker",
    provider: "docker",
    image: "ghcr.io/trycua/cua-xfce:latest",
    host: "127.0.0.1",
    port: 49201,
    containerId: "abc123",
    lastHealthStatus: "ok",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

describe("inferLegacyLifecycleState", () => {
  it("is uninitialized without a container id, whatever the health said", () => {
    expect(inferLegacyLifecycleState({ lastHealthStatus: "ok" })).toBe("uninitialized")
    expect(inferLegacyLifecycleState({ lastHealthStatus: "error" })).toBe("uninitialized")
  })

  it.each([
    ["ok", "running"],
    ["starting", "starting"],
    ["error", "error"],
    ["unreachable", "stopped"],
    ["unknown", "stopped"],
  ] as const)("maps health %s to %s when a container exists", (health, expected) => {
    expect(inferLegacyLifecycleState({ containerId: "c", lastHealthStatus: health })).toBe(expected)
  })

  it("does not claim running for an unreachable container", () => {
    expect(
      inferLegacyLifecycleState({ containerId: "c", lastHealthStatus: "unreachable" })
    ).not.toBe("running")
  })
})

describe("migrateSandboxConnectionRow", () => {
  it("maps a legacy docker row onto provider/driver/config", () => {
    const migrated = migrateSandboxConnectionRow(legacyRow())
    expect(migrated).toMatchObject({
      id: "conn-1",
      name: "home-docker",
      provider: "docker",
      driver: LEGACY_SANDBOX_DRIVER,
      state: "running",
      config: {
        provider: "docker",
        image: "ghcr.io/trycua/cua-xfce:latest",
        host: "127.0.0.1",
        port: 49201,
        containerId: "abc123",
      },
    })
  })

  it("attaches the default capability matrix for docker + computer-server", () => {
    expect(migrateSandboxConnectionRow(legacyRow()).capabilities).toEqual(
      defaultSandboxCapabilities("docker", "computer-server")
    )
  })

  it("dual-writes the legacy mirrors so a downgrade still works", () => {
    const migrated = migrateSandboxConnectionRow(legacyRow())
    expect(migrated.image).toBe("ghcr.io/trycua/cua-xfce:latest")
    expect(migrated.host).toBe("127.0.0.1")
    expect(migrated.port).toBe(49201)
    expect(migrated.containerId).toBe("abc123")
  })

  it("preserves timestamps and health fields", () => {
    const migrated = migrateSandboxConnectionRow(
      legacyRow({ lastHealthError: "boom", lastHealthCheckAt: 1500 })
    )
    expect(migrated).toMatchObject({
      createdAt: 1000,
      updatedAt: 2000,
      lastHealthStatus: "ok",
      lastHealthError: "boom",
      lastHealthCheckAt: 1500,
    })
  })

  it("omits absent optional fields rather than writing undefined", () => {
    const migrated = migrateSandboxConnectionRow(
      legacyRow({ containerId: undefined, lastHealthError: undefined })
    )
    expect(migrated).not.toHaveProperty("lastHealthError")
    expect(migrated).not.toHaveProperty("containerId")
    expect(migrated.config).not.toHaveProperty("containerId")
  })

  it.each([
    ["missing image", { image: undefined as unknown as string }],
    ["blank image", { image: "   " }],
  ])("falls back to the default image on %s", (_label, overrides) => {
    expect(migrateSandboxConnectionRow(legacyRow(overrides)).config).toMatchObject({
      image: LEGACY_SANDBOX_IMAGE,
    })
  })

  it("falls back to loopback for a missing host and 0 for a missing port", () => {
    const migrated = migrateSandboxConnectionRow(
      legacyRow({ host: undefined as unknown as string, port: undefined as unknown as number })
    )
    expect(migrated.config).toMatchObject({ host: "127.0.0.1", port: 0 })
  })

  it("defaults an absent health status to unknown", () => {
    const migrated = migrateSandboxConnectionRow(
      legacyRow({ lastHealthStatus: undefined as never, containerId: undefined })
    )
    expect(migrated.lastHealthStatus).toBe("unknown")
  })

  it("is idempotent — re-running returns a normalized migrated row untouched", () => {
    const once = migrateSandboxConnectionRow(legacyRow())
    const twice = migrateSandboxConnectionRow(once)
    expect(twice).toBe(once)
  })

  it("narrows stored computer-server workspace capabilities on every read", () => {
    const migrated = migrateSandboxConnectionRow(legacyRow())
    const overclaimed: SandboxConnectionRow = {
      ...migrated,
      capabilities: { ...migrated.capabilities, workspaceRead: true, workspaceExec: true },
    }

    const normalized = migrateSandboxConnectionRow(overclaimed)

    expect(normalized.capabilities.workspaceRead).toBe(false)
    expect(normalized.capabilities.workspaceExec).toBe(false)
    expect(normalized).not.toBe(overclaimed)
    expect(migrateSandboxConnectionRow(normalized)).toBe(normalized)
  })

  it("keeps implemented Docker lifecycle and GUI capabilities", () => {
    const migrated = migrateSandboxConnectionRow(legacyRow())
    expect(migrated.capabilities).toMatchObject({
      start: true,
      stop: true,
      delete: true,
      health: true,
      gui: true,
      workspaceRead: false,
      workspaceExec: false,
    })
  })

  it.each([
    [
      "cua-cloud",
      { provider: "cua-cloud", instanceName: "desk-1", host: "cloud.example", port: 443 },
    ],
    ["lume", { provider: "lume", vmName: "compat-vm" }],
  ] as const)(
    "retains %s configuration while removing unsupported operations",
    (provider, config) => {
      const docker = migrateSandboxConnectionRow(legacyRow())
      const imported = {
        ...docker,
        provider,
        config,
        capabilities: Object.fromEntries(
          Object.keys(docker.capabilities).map((operation) => [operation, true])
        ),
      } as SandboxConnectionRow

      const normalized = migrateSandboxConnectionRow(imported)

      expect(normalized.config).toEqual(config)
      expect(Object.values(normalized.capabilities).every((enabled) => !enabled)).toBe(true)
    }
  )

  it("does not clobber a config the user edited after migration", () => {
    const migrated = migrateSandboxConnectionRow(legacyRow())
    const edited: SandboxConnectionRow = {
      ...migrated,
      config: { provider: "docker", image: "my/custom:tag", host: "10.0.0.5", port: 8000 },
    }
    expect(migrateSandboxConnectionRow(edited).config).toMatchObject({ image: "my/custom:tag" })
  })

  it("re-migrates a row left half-written by an interrupted upgrade", () => {
    const half = { ...legacyRow(), config: undefined, driver: "computer-server" } as never
    const migrated = migrateSandboxConnectionRow(half)
    expect(migrated.config).toMatchObject({ provider: "docker" })
    expect(migrated.capabilities).toBeDefined()
  })
})

describe("isMigratedSandboxConnection", () => {
  it("accepts a fully-migrated row", () => {
    expect(isMigratedSandboxConnection(migrateSandboxConnectionRow(legacyRow()))).toBe(true)
  })

  it("rejects a legacy row", () => {
    expect(isMigratedSandboxConnection(legacyRow() as never)).toBe(false)
  })

  it("rejects a row whose config discriminant disagrees with its provider", () => {
    const row = migrateSandboxConnectionRow(legacyRow())
    expect(isMigratedSandboxConnection({ ...row, provider: "lume" })).toBe(false)
  })

  it.each(["capabilities", "state", "driver"] as const)("rejects a row missing %s", (field) => {
    const row = { ...migrateSandboxConnectionRow(legacyRow()) }
    delete (row as Record<string, unknown>)[field]
    expect(isMigratedSandboxConnection(row)).toBe(false)
  })
})

describe("syncLegacySandboxMirrors", () => {
  it("refreshes the mirrors from config for a docker row", () => {
    const row = migrateSandboxConnectionRow(legacyRow())
    const edited: SandboxConnectionRow = {
      ...row,
      config: { provider: "docker", image: "new:tag", host: "10.0.0.5", port: 9000 },
    }
    expect(syncLegacySandboxMirrors(edited)).toMatchObject({
      image: "new:tag",
      host: "10.0.0.5",
      port: 9000,
    })
  })

  it("drops the containerId mirror when the container is gone", () => {
    const row = migrateSandboxConnectionRow(legacyRow())
    const stopped: SandboxConnectionRow = {
      ...row,
      config: { provider: "docker", image: "i", host: "h", port: 1 },
    }
    expect(syncLegacySandboxMirrors(stopped)).not.toHaveProperty("containerId")
  })

  it("writes no mirrors for a cloud row — the old build must not docker-start it", () => {
    const row: SandboxConnectionRow = {
      ...migrateSandboxConnectionRow(legacyRow()),
      provider: "cua-cloud",
      config: { provider: "cua-cloud", instanceName: "desk-1", host: "h", port: 443 },
    }
    const synced = syncLegacySandboxMirrors(row)
    expect(synced).not.toHaveProperty("image")
    expect(synced).not.toHaveProperty("host")
    expect(synced).not.toHaveProperty("port")
    expect(synced).not.toHaveProperty("containerId")
  })

  it("writes no mirrors for a lume row", () => {
    const row: SandboxConnectionRow = {
      ...migrateSandboxConnectionRow(legacyRow()),
      provider: "lume",
      config: { provider: "lume", vmName: "vm-1" },
    }
    expect(syncLegacySandboxMirrors(row)).not.toHaveProperty("image")
  })
})

describe("migrateSandboxConnectionRows", () => {
  it("counts only the rows that actually changed", () => {
    const already = migrateSandboxConnectionRow(legacyRow({ id: "already" }))
    const result = migrateSandboxConnectionRows([
      legacyRow({ id: "a" }),
      already,
      legacyRow({ id: "b" }),
    ])
    expect(result.changed).toBe(2)
    expect(result.rows).toHaveLength(3)
    expect(result.rows[1]).toBe(already)
  })

  it("reports zero changes for an already-migrated table", () => {
    const rows = [legacyRow({ id: "a" }), legacyRow({ id: "b" })].map(migrateSandboxConnectionRow)
    expect(migrateSandboxConnectionRows(rows).changed).toBe(0)
  })

  it("counts an already-migrated row whose stored capabilities are narrowed", () => {
    const row = migrateSandboxConnectionRow(legacyRow())
    const overclaimed = {
      ...row,
      capabilities: { ...row.capabilities, workspaceExec: true },
    }
    const result = migrateSandboxConnectionRows([overclaimed])
    expect(result.changed).toBe(1)
    expect(result.rows[0].capabilities.workspaceExec).toBe(false)
  })

  it("handles an empty table", () => {
    expect(migrateSandboxConnectionRows([])).toEqual({ rows: [], changed: 0 })
  })

  it("is idempotent across a rerun", () => {
    const first = migrateSandboxConnectionRows([legacyRow()])
    const second = migrateSandboxConnectionRows(first.rows)
    expect(second.changed).toBe(0)
    expect(second.rows[0]).toBe(first.rows[0])
  })
})
