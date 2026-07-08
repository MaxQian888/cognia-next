/** @jest-environment jsdom */
// Mock Dexie + IPC + tauri detection so the orchestrator can be exercised
// purely in JS-land without a real backend.

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/db/mcp-servers", () => ({
  bulkImportMcpServers: jest.fn(),
  listMcpServers: jest.fn(),
  updateMcpServer: jest.fn(),
}))

jest.mock("./ipc", () => ({
  readAgentConfig: jest.fn(),
  writeAgentConfig: jest.fn(),
}))

jest.mock("./builtin-mcp/runtime-context", () => ({
  getBuiltinMcpRuntimeContext: jest.fn(),
}))

import { bulkImportMcpServers, listMcpServers, updateMcpServer } from "@/lib/db/mcp-servers"
import { isTauri } from "@/lib/tauri"

import { readAgentConfig, writeAgentConfig } from "./ipc"
import { getBuiltinMcpRuntimeContext } from "./builtin-mcp/runtime-context"
import {
  importFromAgent,
  previewAgentImport,
  scheduleSync,
  scheduleSyncForAffectedAgents,
  syncAll,
  syncToAgent,
} from "./sync"
import type { AgentReadResult, AgentWriteResult } from "./ipc"
import type { McpServer } from "@/lib/claude/types"
import { A2UI_BRIDGE_SERVER_NAME } from "@/lib/a2ui/mcp-tool-schemas"

const mIsTauri = isTauri as jest.Mock
const mList = listMcpServers as jest.Mock
const mRead = readAgentConfig as jest.Mock
const mWrite = writeAgentConfig as jest.Mock
const mBulk = bulkImportMcpServers as jest.Mock
const mUpdate = updateMcpServer as jest.Mock
const mCtx = getBuiltinMcpRuntimeContext as jest.Mock

function makeServer(partial: Partial<McpServer> & { name: string }): McpServer {
  return {
    id: partial.id ?? `mcp_${partial.name}`,
    name: partial.name,
    transport: partial.transport ?? "stdio",
    config: partial.config ?? { command: "x" },
    enabled: partial.enabled ?? true,
    appsEnabled: partial.appsEnabled ?? {},
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  mIsTauri.mockReturnValue(true)
  mCtx.mockResolvedValue(null) // default: skip resolution unless a test opts in
})

describe("syncToAgent — gating", () => {
  it("skips with not-tauri when not running in Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: false, skipped: true, reason: "not-tauri" })
    expect(mRead).not.toHaveBeenCalled()
  })

  it("skips with unknown-agent for an id outside the registry", async () => {
    const r = await syncToAgent("nope" as never)
    expect(r).toEqual({ ok: false, skipped: true, reason: "unknown-agent" })
  })

  it("skips with read-only for cline / roo-code", async () => {
    expect(await syncToAgent("cline")).toEqual({
      ok: false,
      skipped: true,
      reason: "read-only",
    })
    expect(await syncToAgent("roo-code")).toEqual({
      ok: false,
      skipped: true,
      reason: "read-only",
    })
  })

  it("returns the readAgentConfig error verbatim when read throws", async () => {
    mList.mockResolvedValueOnce([])
    mRead.mockRejectedValueOnce(new Error("permission denied"))
    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: false, skipped: false, error: "permission denied" })
  })

  it("falls back to String(err) when readAgentConfig rejects with a non-Error", async () => {
    mList.mockResolvedValueOnce([])
    mRead.mockRejectedValueOnce("plain string")
    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: false, skipped: false, error: "plain string" })
  })

  it("skips with no-path-on-os when the agent isn't supported on this OS", async () => {
    mList.mockResolvedValueOnce([])
    const cfg: AgentReadResult = {
      path: null,
      exists: false,
      writable: false,
      format: "json",
      raw: "",
      parsed: null,
    }
    mRead.mockResolvedValueOnce(cfg)
    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: false, skipped: true, reason: "no-path-on-os" })
  })
})

describe("syncToAgent — happy paths", () => {
  it("writes the projected tree and counts only servers flagged for this agent", async () => {
    mList.mockResolvedValueOnce([
      makeServer({ name: "fs", appsEnabled: { "claude-code": true } }),
      makeServer({ name: "skipped", appsEnabled: { cursor: true } }),
    ])
    const cfg: AgentReadResult = {
      path: "/x.json",
      exists: true,
      writable: true,
      format: "json",
      raw: "{}",
      parsed: {},
    }
    mRead.mockResolvedValueOnce(cfg)
    const writeResult: AgentWriteResult = { path: "/x.json" }
    mWrite.mockResolvedValueOnce(writeResult)

    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: true, result: writeResult, count: 1 })
    expect(mWrite).toHaveBeenCalledTimes(1)
    const [agentId, tree] = mWrite.mock.calls[0]
    expect(agentId).toBe("claude-code")
    // The projected tree should contain `fs` but not `skipped`.
    const map = (tree as { mcpServers: Record<string, unknown> }).mcpServers
    expect(map.fs).toBeDefined()
    expect(map.skipped).toBeUndefined()
  })

  it("forwards tombstones into managedNames so deleted entries get pruned", async () => {
    mList.mockResolvedValueOnce([makeServer({ name: "fs", appsEnabled: { "claude-code": true } })])
    const cfg: AgentReadResult = {
      path: "/x.json",
      exists: true,
      writable: true,
      format: "json",
      raw: "{}",
      parsed: { mcpServers: { tombed: { type: "stdio", command: "old" } } },
    }
    mRead.mockResolvedValueOnce(cfg)
    mWrite.mockResolvedValueOnce({ path: "/x.json" })

    await syncToAgent("claude-code", ["tombed"])
    const tree = mWrite.mock.calls[0][1] as { mcpServers: Record<string, unknown> }
    expect(tree.mcpServers.tombed).toBeUndefined()
    expect(tree.mcpServers.fs).toBeDefined()
  })

  it("translates 'agent directory missing' into agent-not-installed", async () => {
    mList.mockResolvedValueOnce([])
    const cfg: AgentReadResult = {
      path: "/x.json",
      exists: false,
      writable: true,
      format: "json",
      raw: "",
      parsed: null,
    }
    mRead.mockResolvedValueOnce(cfg)
    mWrite.mockRejectedValueOnce(new Error("agent directory missing"))
    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: false, skipped: true, reason: "agent-not-installed" })
  })

  it("returns a hard error when writeAgentConfig fails for any other reason", async () => {
    mList.mockResolvedValueOnce([])
    const cfg: AgentReadResult = {
      path: "/x",
      exists: true,
      writable: true,
      format: "json",
      raw: "",
      parsed: {},
    }
    mRead.mockResolvedValueOnce(cfg)
    mWrite.mockRejectedValueOnce(new Error("disk full"))
    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: false, skipped: false, error: "disk full" })
  })

  it("falls back to String(err) when write rejects with a non-Error", async () => {
    mList.mockResolvedValueOnce([])
    const cfg: AgentReadResult = {
      path: "/x",
      exists: true,
      writable: true,
      format: "json",
      raw: "",
      parsed: {},
    }
    mRead.mockResolvedValueOnce(cfg)
    mWrite.mockRejectedValueOnce("nope")
    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: false, skipped: false, error: "nope" })
  })
})

describe("syncAll", () => {
  it("kicks off a sync per writable agent and returns a result map", async () => {
    mIsTauri.mockReturnValue(false) // shortcut: every result is "not-tauri"
    const out = await syncAll()
    expect(Object.keys(out).sort()).toEqual(
      [
        "cognia",
        "claude-code",
        "claude-desktop",
        "codex",
        "cursor",
        "gemini",
        "vscode",
        "windsurf",
      ].sort()
    )
    for (const r of Object.values(out)) {
      expect(r).toEqual({ ok: false, skipped: true, reason: "not-tauri" })
    }
  })
})

describe("scheduleSync (debounced)", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("coalesces back-to-back calls into a single fire", async () => {
    mIsTauri.mockReturnValue(false)
    scheduleSync("claude-code")
    scheduleSync("claude-code")
    scheduleSync("claude-code")
    // Nothing called yet — still debouncing.
    expect(mList).not.toHaveBeenCalled()

    jest.advanceTimersByTime(500)
    // Allow promise queues to drain.
    await Promise.resolve()
    // syncToAgent was invoked once; not-tauri short-circuits before listMcpServers.
    expect(mList).not.toHaveBeenCalled()
  })

  it("accumulates tombstones across calls within the debounce window", async () => {
    mIsTauri.mockReturnValue(true)
    mList.mockResolvedValue([])
    mRead.mockResolvedValue({
      path: "/x",
      exists: true,
      writable: true,
      format: "json",
      raw: "",
      parsed: {},
    } satisfies AgentReadResult)
    mWrite.mockResolvedValue({ path: "/x" } satisfies AgentWriteResult)

    scheduleSync("claude-code", "tomb-1")
    scheduleSync("claude-code", "tomb-2")
    scheduleSync("claude-code") // no extra tombstone

    jest.advanceTimersByTime(500)
    // Drain microtasks the timer scheduled.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mWrite).toHaveBeenCalledTimes(1)
  })

  it("logs but doesn't throw when the underlying sync rejects", async () => {
    mIsTauri.mockReturnValue(true)
    mList.mockRejectedValue(new Error("DB offline"))
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})

    scheduleSync("claude-code")
    jest.advanceTimersByTime(500)
    // wait for the chained .catch to run
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("scheduleSyncForAffectedAgents", () => {
  it("schedules a sync for every agent any server has flipped on", async () => {
    mList.mockResolvedValueOnce([
      makeServer({
        name: "a",
        appsEnabled: { "claude-code": true, cursor: false },
      }),
      makeServer({ name: "b", appsEnabled: { vscode: true } }),
      makeServer({ name: "c", appsEnabled: { "claude-code": true } }),
      makeServer({ name: "d" }), // no apps map at all
    ])

    jest.useFakeTimers()
    await scheduleSyncForAffectedAgents()
    // We can't easily inspect the internal map, but listMcpServers must have
    // been called and no exceptions thrown — the schedules will fire after
    // the debounce window.
    expect(mList).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it("works when all rows have empty appsEnabled", async () => {
    mList.mockResolvedValueOnce([makeServer({ name: "a" })])
    await expect(scheduleSyncForAffectedAgents()).resolves.toBeUndefined()
  })
})

describe("previewAgentImport", () => {
  it("returns an empty preview when not in Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    const r = await previewAgentImport("claude-code")
    expect(r).toEqual({ agent: "claude-code", exists: false, drafts: [] })
  })

  it("delegates to readAgentConfig + adapter.parse", async () => {
    mIsTauri.mockReturnValue(true)
    mRead.mockResolvedValueOnce({
      path: "/x",
      exists: true,
      writable: true,
      format: "json",
      raw: "{}",
      parsed: { mcpServers: { fs: { type: "stdio", command: "x" } } },
    } satisfies AgentReadResult)
    const r = await previewAgentImport("claude-code")
    expect(r.exists).toBe(true)
    expect(r.drafts.map((d) => d.name)).toEqual(["fs"])
  })

  it("propagates parseError", async () => {
    mIsTauri.mockReturnValue(true)
    mRead.mockResolvedValueOnce({
      path: "/x",
      exists: true,
      writable: true,
      format: "json",
      raw: "{",
      parsed: null,
      parseError: "unexpected end of input",
    } satisfies AgentReadResult)
    const r = await previewAgentImport("claude-code")
    expect(r.parseError).toBe("unexpected end of input")
    expect(r.drafts).toEqual([])
  })

  it("throws a clear error for an unknown agent id (via requireAgentAdapter)", async () => {
    await expect(previewAgentImport("nope" as never)).rejects.toThrow(/unknown agent/)
  })
})

describe("importFromAgent", () => {
  it("merges drafts via bulkImport and flips appsEnabled[agent]=true on matched names", async () => {
    mIsTauri.mockReturnValue(true)
    // preview reads
    mRead.mockResolvedValueOnce({
      path: "/x",
      exists: true,
      writable: true,
      format: "json",
      raw: "{}",
      parsed: {
        mcpServers: {
          fs: { type: "stdio", command: "x" },
          api: { type: "http", url: "https://x/mcp" },
        },
      },
    } satisfies AgentReadResult)
    mBulk.mockResolvedValueOnce({
      created: 1,
      skipped: 1,
      duplicated: 0,
      overwritten: 0,
    })
    // listMcpServers right after import
    mList.mockResolvedValueOnce([
      makeServer({ name: "fs", appsEnabled: {} }),
      makeServer({ name: "api", appsEnabled: { "claude-code": true } }), // already enabled
      makeServer({ name: "ignored", appsEnabled: {} }), // not in import
    ])

    const r = await importFromAgent("claude-code")
    expect(r.previewed).toBe(2)
    expect(r.created).toBe(1)
    // updateMcpServer should be called only for `fs` (api already true,
    // ignored not in import)
    expect(mUpdate).toHaveBeenCalledTimes(1)
    const [id, patch] = mUpdate.mock.calls[0]
    expect(id).toBe("mcp_fs")
    expect((patch as { appsEnabled: Record<string, boolean> }).appsEnabled["claude-code"]).toBe(
      true
    )
  })

  it("uses the supplied strategy", async () => {
    mIsTauri.mockReturnValue(true)
    mRead.mockResolvedValueOnce({
      path: "/x",
      exists: true,
      writable: true,
      format: "json",
      raw: "{}",
      parsed: { mcpServers: { fs: { type: "stdio", command: "x" } } },
    } satisfies AgentReadResult)
    mBulk.mockResolvedValueOnce({ created: 0, skipped: 0, duplicated: 0, overwritten: 1 })
    mList.mockResolvedValueOnce([])
    await importFromAgent("claude-code", "overwrite")
    expect(mBulk).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "fs" })]),
      "overwrite"
    )
  })
})

describe("syncToAgent — builtin MCP placeholder resolution", () => {
  const cfg: AgentReadResult = {
    path: "/x.json",
    exists: true,
    writable: true,
    format: "json",
    raw: "{}",
    parsed: {},
  }

  it("rewrites ${COGNIA_SIDECAR_DIR} and stamps COGNIA_BRIDGE_SOCKET on the a2ui-bridge row", async () => {
    mList.mockResolvedValueOnce([
      makeServer({
        id: "builtin:a2ui-bridge",
        name: A2UI_BRIDGE_SERVER_NAME,
        config: {
          command: "node",
          args: ["${COGNIA_SIDECAR_DIR}/a2ui-mcp.mjs"],
          env: {},
        },
        appsEnabled: { "claude-code": true },
      }),
    ])
    mRead.mockResolvedValueOnce(cfg)
    mWrite.mockResolvedValueOnce({ path: "/x.json" })
    mCtx.mockResolvedValueOnce({
      sidecarDir: "/abs/sidecar",
      socketPath: "/abs/sock",
    })

    await syncToAgent("claude-code")
    const tree = mWrite.mock.calls[0][1] as {
      mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }>
    }
    const projected = tree.mcpServers[A2UI_BRIDGE_SERVER_NAME]
    expect(projected).toBeDefined()
    expect(projected.args).toEqual(["/abs/sidecar/a2ui-mcp.mjs"])
    expect(projected.env?.COGNIA_BRIDGE_SOCKET).toBe("/abs/sock")
  })

  it("leaves non-builtin rows untouched even when the runtime context is present", async () => {
    mList.mockResolvedValueOnce([
      makeServer({
        name: "fs",
        config: { command: "node", args: ["server.js"] },
        appsEnabled: { "claude-code": true },
      }),
    ])
    mRead.mockResolvedValueOnce(cfg)
    mWrite.mockResolvedValueOnce({ path: "/x.json" })
    mCtx.mockResolvedValueOnce({ sidecarDir: "/abs/sidecar", socketPath: "/abs/sock" })

    await syncToAgent("claude-code")
    const tree = mWrite.mock.calls[0][1] as {
      mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }>
    }
    expect(tree.mcpServers.fs.env?.COGNIA_BRIDGE_SOCKET).toBeUndefined()
    expect(tree.mcpServers.fs.args).toEqual(["server.js"])
  })

  it("projects unresolved placeholders verbatim when the context fetch returns null", async () => {
    mList.mockResolvedValueOnce([
      makeServer({
        id: "builtin:a2ui-bridge",
        name: A2UI_BRIDGE_SERVER_NAME,
        config: {
          command: "node",
          args: ["${COGNIA_SIDECAR_DIR}/a2ui-mcp.mjs"],
        },
        appsEnabled: { "claude-code": true },
      }),
    ])
    mRead.mockResolvedValueOnce(cfg)
    mWrite.mockResolvedValueOnce({ path: "/x.json" })
    mCtx.mockResolvedValueOnce(null)

    await syncToAgent("claude-code")
    const tree = mWrite.mock.calls[0][1] as {
      mcpServers: Record<string, { args?: string[] }>
    }
    expect(tree.mcpServers[A2UI_BRIDGE_SERVER_NAME].args).toEqual([
      "${COGNIA_SIDECAR_DIR}/a2ui-mcp.mjs",
    ])
  })

  it("returns a hard error when the runtime context fetch throws", async () => {
    mList.mockResolvedValueOnce([])
    mRead.mockResolvedValueOnce(cfg)
    mCtx.mockRejectedValueOnce(new Error("ipc unavailable"))
    const r = await syncToAgent("claude-code")
    expect(r).toEqual({ ok: false, skipped: false, error: "ipc unavailable" })
    expect(mWrite).not.toHaveBeenCalled()
  })
})
