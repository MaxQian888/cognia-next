/**
 * @jest-environment node
 */
import type { McpServer, SendOptions } from "@cognia/agent-config-types"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

import { registerTurnSubagentContext } from "./turn-dispatch"
import { getCliSubagentContext } from "./subagent-dispatch"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import type { ResolvedCliSessionContext } from "./session-context"
import type { AgentSummary } from "./discover-agents"
import type { PermissionResponder } from "./permission-gate"

const HOME = "/home/u/.cognia"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: {},
  cwd: "/work",
}

const gate: PermissionResponder = async () => ({ decision: "allow" })

const subagent = (id: string): AgentSummary => ({
  id,
  name: id,
  description: id,
  def: { id, name: id, description: id, prompt: id },
})

function session(overrides: Partial<ResolvedCliSessionContext> = {}): ResolvedCliSessionContext {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    cwd: "/work",
    additionalDirectories: [],
    sendOptions: {} as SendOptions,
    mcpServers: [{ name: "alpha", enabled: true } as unknown as McpServer],
    agents: [subagent("explorer")],
    subagentToolEnabled: true,
    activeSkillIds: [],
    databaseError: null,
    contextVersion: "v1",
    ...overrides,
  }
}

describe("registerTurnSubagentContext", () => {
  it("publishes the turn's gate, signal, roots and MCP rows, then clears them", () => {
    const s = session()
    const controller = new AbortController()
    const resolveSubagentOptions = jest.fn(async () => ({}) as SendOptions)
    const resolveSubagentGate = jest.fn(() => gate)
    const clear = registerTurnSubagentContext({
      session: s,
      config,
      home: HOME,
      gate,
      resolveSubagentOptions,
      resolveSubagentGate,
      signal: controller.signal,
      approvedTools: new Set(["write"]),
      disabledMcpTools: new Set(["mcp__alpha__x"]),
    })
    const ctx = getCliSubagentContext(s.sessionId)
    expect(ctx).toBeDefined()
    expect(ctx!.agents.map((a) => a.id)).toEqual(["explorer"])
    expect(ctx!.cwd).toBe("/work")
    expect(ctx!.home).toBe(HOME)
    expect(ctx!.gate).toBe(gate)
    expect(ctx!.resolveSubagentOptions).toBe(resolveSubagentOptions)
    expect(ctx!.resolveSubagentGate).toBe(resolveSubagentGate)
    expect(ctx!.signal).toBe(controller.signal)
    expect(ctx!.mcpServers).toBe(s.mcpServers)
    expect([...ctx!.approvedTools]).toEqual(["write"])
    expect([...ctx!.disabledMcpTools]).toEqual(["mcp__alpha__x"])
    clear()
    expect(getCliSubagentContext(s.sessionId)).toBeUndefined()
  })

  it("registers nothing when the dispatch tool was never surfaced", () => {
    const s = session({ subagentToolEnabled: false })
    const clear = registerTurnSubagentContext({
      session: s,
      config,
      home: HOME,
      gate,
      approvedTools: new Set(),
      disabledMcpTools: new Set(),
    })
    expect(getCliSubagentContext(s.sessionId)).toBeUndefined()
    // The cleanup is still safe to call.
    expect(() => clear()).not.toThrow()
  })

  it("registers nothing when the session discovered no subagents", () => {
    const s = session({ agents: [] })
    registerTurnSubagentContext({
      session: s,
      config,
      home: HOME,
      gate,
      approvedTools: new Set(),
      disabledMcpTools: new Set(),
    })
    expect(getCliSubagentContext(s.sessionId)).toBeUndefined()
  })

  it("omits the signal entirely when the turn has none (never registers undefined)", () => {
    const s = session()
    const clear = registerTurnSubagentContext({
      session: s,
      config,
      home: HOME,
      gate,
      approvedTools: new Set(),
      disabledMcpTools: new Set(),
    })
    expect("signal" in getCliSubagentContext(s.sessionId)!).toBe(false)
    clear()
  })
})
