import {
  PI_MIGRATION_SNAPSHOT_VERSION,
  evaluatePiMigrationReadiness,
  isLegacyPiAcpAgent,
  isMigratedPiAgent,
  migrateToPiRpc,
  readMigrationSnapshot,
  rollbackPiRpcMigration,
} from "./pi-migration"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

const NOW = new Date("2026-08-14T12:00:00.000Z")

function legacyAgent(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent-pi",
    name: "Pi",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "npx", args: ["-y", "pi-acp"], cwd: "/work" },
    defaultPermissionMode: "acceptEdits",
    timeout: 123456,
    tags: ["coding"],
    metadata: {
      preset: "pi",
      ecosystemAdapterId: "pi",
      ecosystemSurfaceId: "acp-stdio",
      ecosystemSupportTier: "executable",
      ecosystemDocsUrl: "https://github.com/svkozak/pi-acp",
    },
    ...overrides,
  }
}

describe("isLegacyPiAcpAgent", () => {
  it("recognises the shipped legacy configuration", () => {
    expect(isLegacyPiAcpAgent(legacyAgent())).toBe(true)
  })

  /**
   * All three conditions are required. Each of these would be a false positive
   * that silently rewrote a config the user meant to keep.
   */
  it("requires the preset label", () => {
    expect(isLegacyPiAcpAgent(legacyAgent({ metadata: { preset: "claude-code" } }))).toBe(false)
    expect(isLegacyPiAcpAgent(legacyAgent({ metadata: {} }))).toBe(false)
    expect(isLegacyPiAcpAgent(legacyAgent({ metadata: undefined }))).toBe(false)
  })

  it("requires the ACP protocol, so an already-migrated agent is not re-detected", () => {
    expect(isLegacyPiAcpAgent(legacyAgent({ protocol: "pi-rpc" }))).toBe(false)
  })

  it("requires the pi-acp npx invocation", () => {
    expect(
      isLegacyPiAcpAgent(legacyAgent({ process: { command: "npx", args: ["-y", "other"] } }))
    ).toBe(false)
    expect(
      isLegacyPiAcpAgent(legacyAgent({ process: { command: "pi", args: ["--mode", "rpc"] } }))
    ).toBe(false)
    expect(isLegacyPiAcpAgent(legacyAgent({ process: undefined }))).toBe(false)
  })

  it("finds the package past any flag order, matching the spawn allowlist", () => {
    expect(
      isLegacyPiAcpAgent(legacyAgent({ process: { command: "npx", args: ["--yes", "pi-acp"] } }))
    ).toBe(true)
    expect(isLegacyPiAcpAgent(legacyAgent({ process: { command: "NPX", args: ["pi-acp"] } }))).toBe(
      true
    )
  })
})

describe("migrateToPiRpc", () => {
  it("rewrites the transport fields onto the native adapter", () => {
    const { config } = migrateToPiRpc(legacyAgent(), { now: () => NOW })
    expect(config.protocol).toBe("pi-rpc")
    expect(config.process).toMatchObject({ command: "pi", args: ["--mode", "rpc"] })
    expect(config.metadata?.preset).toBe("pi-rpc")
    expect(config.metadata?.ecosystemSurfaceId).toBe("rpc-stdio")
  })

  /**
   * The whole reason migration is in-place: teams, the scheduler and any live
   * runtime hold this id. A create-then-delete would orphan all of them.
   */
  it("preserves the agent id and every non-transport choice", () => {
    const before = legacyAgent()
    const { config } = migrateToPiRpc(before, { now: () => NOW })
    expect(config.id).toBe(before.id)
    expect(config.name).toBe(before.name)
    expect(config.enabled).toBe(before.enabled)
    expect(config.defaultPermissionMode).toBe("acceptEdits")
    expect(config.timeout).toBe(123456)
    expect(config.tags).toEqual(["coding"])
    expect(config.process?.cwd).toBe("/work")
  })

  it("does not mutate the input config", () => {
    const before = legacyAgent()
    migrateToPiRpc(before, { now: () => NOW })
    expect(before.protocol).toBe("acp")
    expect(before.process?.command).toBe("npx")
    expect(before.metadata?.piMigration).toBeUndefined()
  })

  it("captures a versioned rollback snapshot", () => {
    const { config, snapshot } = migrateToPiRpc(legacyAgent(), { now: () => NOW })
    expect(snapshot).toEqual({
      version: PI_MIGRATION_SNAPSHOT_VERSION,
      migratedAt: NOW.toISOString(),
      from: {
        protocol: "acp",
        preset: "pi",
        process: { command: "npx", args: ["-y", "pi-acp"], cwd: "/work" },
        ecosystemAdapterId: "pi",
        ecosystemSurfaceId: "acp-stdio",
        ecosystemSupportTier: "executable",
        ecosystemDocsUrl: "https://github.com/svkozak/pi-acp",
      },
    })
    expect(readMigrationSnapshot(config)).toEqual(snapshot)
    expect(isMigratedPiAgent(config)).toBe(true)
  })

  it("refuses to migrate anything that is not the legacy bridge", () => {
    expect(() => migrateToPiRpc(legacyAgent({ protocol: "pi-rpc" }))).toThrow(/not a legacy/)
  })
})

describe("rollbackPiRpcMigration", () => {
  it("restores the exact pre-migration configuration", () => {
    const before = legacyAgent()
    const { config: migrated } = migrateToPiRpc(before, { now: () => NOW })
    const restored = rollbackPiRpcMigration(migrated)!

    expect(restored.protocol).toBe("acp")
    expect(restored.process).toMatchObject({ command: "npx", args: ["-y", "pi-acp"], cwd: "/work" })
    expect(restored.metadata?.preset).toBe("pi")
    expect(restored.metadata?.ecosystemSurfaceId).toBe("acp-stdio")
    expect(restored.id).toBe(before.id)
  })

  it("clears the snapshot so the agent is detectable as legacy again", () => {
    const { config } = migrateToPiRpc(legacyAgent(), { now: () => NOW })
    const restored = rollbackPiRpcMigration(config)!
    expect(restored.metadata?.piMigration).toBeUndefined()
    expect(isMigratedPiAgent(restored)).toBe(false)
    // A full round trip must land back where it started.
    expect(isLegacyPiAcpAgent(restored)).toBe(true)
  })

  it("returns null when there is nothing to roll back", () => {
    expect(rollbackPiRpcMigration(legacyAgent())).toBeNull()
  })

  /**
   * A snapshot written by a future Cognia is not reconstructed by guesswork —
   * offering a rollback we cannot perform faithfully is worse than not
   * offering one.
   */
  it("ignores a snapshot from an unknown future version", () => {
    const config = legacyAgent({
      metadata: { preset: "pi-rpc", piMigration: { version: 99, from: { protocol: "acp" } } },
    })
    expect(readMigrationSnapshot(config)).toBeNull()
    expect(rollbackPiRpcMigration(config)).toBeNull()
  })

  it("ignores a malformed snapshot", () => {
    for (const piMigration of [null, "nope", {}, { version: 1 }, { version: 1, from: {} }]) {
      const config = legacyAgent({ metadata: { preset: "pi-rpc", piMigration } })
      expect(readMigrationSnapshot(config)).toBeNull()
    }
  })
})

describe("evaluatePiMigrationReadiness", () => {
  it("is ready when the binary, version and sandbox all check out", () => {
    expect(
      evaluatePiMigrationReadiness({
        commandAvailable: true,
        versionStatus: "certified",
        sandboxReady: true,
      })
    ).toEqual({ ready: true, blockers: [] })
  })

  it("treats an unverified newer Pi as runnable, not as a blocker", () => {
    expect(
      evaluatePiMigrationReadiness({
        commandAvailable: true,
        versionStatus: "unverified",
        sandboxReady: true,
      }).ready
    ).toBe(true)
  })

  it("blocks on a missing binary, an unsupported version, or no sandbox", () => {
    expect(
      evaluatePiMigrationReadiness({
        commandAvailable: false,
        versionStatus: "unsupported",
        sandboxReady: false,
      })
    ).toEqual({
      ready: false,
      blockers: ["command_missing", "runtime_version_unsupported", "sandbox_unavailable"],
    })
  })

  it("blocks on the sandbox alone, since there is no unsandboxed fallback", () => {
    expect(
      evaluatePiMigrationReadiness({
        commandAvailable: true,
        versionStatus: "certified",
        sandboxReady: false,
      })
    ).toEqual({ ready: false, blockers: ["sandbox_unavailable"] })
  })
})
