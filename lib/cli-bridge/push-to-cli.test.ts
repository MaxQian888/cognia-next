import { countPushErrors, countPushSuccesses, pushToCli, type PushToCliDeps } from "./push-to-cli"
import type { AppSettings } from "@/lib/claude/types"
import type { SyncResult } from "@/lib/claude/sync"

// Mocks back the `?? default` delegations exercised by the no-deps test below;
// every other test injects deps and bypasses these.
jest.mock("./home", () => ({ resolveCliHome: jest.fn(async () => "/home/.cognia") }))
jest.mock("./push-config", () => ({ pushConfigToCli: jest.fn(async () => true) }))
jest.mock("./push-credentials", () => ({ pushCredentialsToCli: jest.fn(async () => 1) }))
jest.mock("./push-history", () => ({ pushHistoryToCli: jest.fn(async () => 2) }))
jest.mock("@/lib/claude/sync", () => ({
  syncToAgent: jest.fn(async () => ({ ok: true, result: { path: "p" }, count: 1 })),
}))

const SETTINGS = { id: "singleton" } as AppSettings

function deps(over: Partial<PushToCliDeps> = {}): PushToCliDeps {
  return {
    resolveHome: async () => "/home/.cognia",
    pushConfig: async () => true,
    pushCredentials: async () => 2,
    pushHistory: async () => 5,
    syncMcp: async (): Promise<SyncResult> => ({ ok: true, result: { path: "p" }, count: 3 }),
    ...over,
  }
}

describe("pushToCli", () => {
  it("runs every requested item and reports per-item success", async () => {
    const report = await pushToCli(SETTINGS, undefined, deps())
    expect(report.home).toBe("/home/.cognia")
    expect(report.config?.ok).toBe(true)
    expect(report.credentials).toEqual({ ok: true, detail: "2 provider(s)" })
    expect(report.history).toEqual({ ok: true, detail: "5 entr(ies)" })
    expect(report.mcp).toEqual({ ok: true, detail: "3 server(s)" })
    expect(countPushSuccesses(report)).toBe(4)
    expect(countPushErrors(report)).toBe(0)
  })

  it("runs the real default operations when no deps are injected", async () => {
    const report = await pushToCli(SETTINGS)
    expect(report.home).toBe("/home/.cognia")
    expect(report.config?.ok).toBe(true)
    expect(report.credentials?.ok).toBe(true)
    expect(report.history?.ok).toBe(true)
    expect(report.mcp?.ok).toBe(true)
  })

  it("skips everything when there is no CLI home", async () => {
    const report = await pushToCli(SETTINGS, undefined, deps({ resolveHome: async () => null }))
    expect(report.home).toBeNull()
    expect(report.config).toEqual({ ok: false, skipped: true, detail: "no-cli-home" })
    expect(report.mcp).toEqual({ ok: false, skipped: true, detail: "no-cli-home" })
    expect(countPushSuccesses(report)).toBe(0)
  })

  it("only runs the selected items", async () => {
    const pushConfig = jest.fn(async () => true)
    const pushCredentials = jest.fn(async () => 1)
    const report = await pushToCli(
      SETTINGS,
      { config: true },
      deps({ pushConfig, pushCredentials })
    )
    expect(pushConfig).toHaveBeenCalled()
    expect(pushCredentials).not.toHaveBeenCalled()
    expect(report.credentials).toBeUndefined()
  })

  it("marks empty pushes as skipped rather than success", async () => {
    const report = await pushToCli(
      SETTINGS,
      undefined,
      deps({ pushCredentials: async () => 0, pushHistory: async () => 0 })
    )
    expect(report.credentials).toEqual({ ok: false, skipped: true, detail: "no-secrets" })
    expect(report.history).toEqual({ ok: false, skipped: true, detail: "no-history" })
    expect(countPushSuccesses(report)).toBe(2) // config + mcp
  })

  it("reports a config skip when pushConfig returns false", async () => {
    const report = await pushToCli(
      SETTINGS,
      { config: true },
      deps({ pushConfig: async () => false })
    )
    expect(report.config).toEqual({ ok: false, skipped: true, detail: "no-cli-home" })
  })

  it("isolates config and history failures independently", async () => {
    const report = await pushToCli(
      SETTINGS,
      undefined,
      deps({
        pushConfig: async () => {
          throw new Error("cfg")
        },
        pushHistory: async () => {
          throw new Error("hist")
        },
      })
    )
    expect(report.config).toEqual({ ok: false, error: "cfg" })
    expect(report.history).toEqual({ ok: false, error: "hist" })
    expect(report.credentials?.ok).toBe(true)
  })

  it("reports an MCP failure thrown by syncMcp", async () => {
    const report = await pushToCli(
      SETTINGS,
      { mcp: true },
      deps({
        syncMcp: async () => {
          throw new Error("sync threw")
        },
      })
    )
    expect(report.mcp).toEqual({ ok: false, error: "sync threw" })
  })

  it("isolates a failing item — others still run", async () => {
    const report = await pushToCli(
      SETTINGS,
      undefined,
      deps({
        pushCredentials: async () => {
          throw new Error("keyring locked")
        },
      })
    )
    expect(report.credentials).toEqual({ ok: false, error: "keyring locked" })
    expect(report.config?.ok).toBe(true)
    expect(countPushErrors(report)).toBe(1)
  })

  it("maps a skipped MCP sync (agent not installed) to a skip", async () => {
    const report = await pushToCli(
      SETTINGS,
      { mcp: true },
      deps({
        syncMcp: async (): Promise<SyncResult> => ({
          ok: false,
          skipped: true,
          reason: "agent-not-installed",
        }),
      })
    )
    expect(report.mcp).toEqual({ ok: false, skipped: true, detail: "agent-not-installed" })
  })

  it("maps an MCP sync error to an error item", async () => {
    const report = await pushToCli(
      SETTINGS,
      { mcp: true },
      deps({
        syncMcp: async (): Promise<SyncResult> => ({ ok: false, skipped: false, error: "boom" }),
      })
    )
    expect(report.mcp).toEqual({ ok: false, error: "boom" })
  })
})
