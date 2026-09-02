/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import { useAgentRuntimeCatalog } from "./use-agent-runtime-catalog"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const runtimeState = {
  runtimeRef: { kind: "builtin" } as AgentRuntimeRef,
  sessionRuntimeRefs: {} as Record<string, AgentRuntimeRef>,
}
jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: (selector: (s: typeof runtimeState) => unknown) => selector(runtimeState),
}))
// The real resolver: a session that chose a lane wins, everything else falls
// back to the app default.
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: (sessionId?: string) =>
    sessionId && Object.hasOwn(runtimeState.sessionRuntimeRefs, sessionId)
      ? runtimeState.sessionRuntimeRefs[sessionId]
      : runtimeState.runtimeRef,
}))

const externalState = {
  enabled: true,
  agents: {} as Record<string, { id: string; name: string; enabled: boolean; protocol: string }>,
  agentValidity: {} as Record<string, Record<string, unknown>>,
}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (s: typeof externalState) => unknown) =>
    selector(externalState),
}))
jest.mock("@/stores/agent/external-agent-store/selectors", () => ({
  hydrateAgentConfig: (stored: unknown) => stored,
}))

const hostState = { configs: [] as Array<Record<string, unknown>>, unavailable: null as unknown }
jest.mock("@/hooks/agent/use-host-external-agent-configs", () => ({
  useHostExternalAgentConfigs: () => hostState,
}))

jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  supportsExternalAgents: () => true,
}))
jest.mock("@/lib/ai/agent/external/protocol-adapter", () => ({
  onProtocolAdapterRegistryChange: () => () => {},
}))
jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
  getExternalAgentExecutionBlock: (agent: { enabled?: boolean }) =>
    agent.enabled === false ? { code: "agent_disabled", reason: "Agent is disabled." } : null,
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({ isFromPreset: () => null }))

function agent(id: string, name: string, enabled = true) {
  return { id, name, enabled, protocol: "acp" }
}

beforeEach(() => {
  runtimeState.runtimeRef = { kind: "builtin" }
  runtimeState.sessionRuntimeRefs = {}
  externalState.enabled = true
  externalState.agents = {}
  externalState.agentValidity = {}
  hostState.configs = []
  hostState.unavailable = null
})

describe("useAgentRuntimeCatalog", () => {
  it("always offers the builtin lane and resolves it as the selection", () => {
    const { result } = renderHook(() => useAgentRuntimeCatalog("anthropic"))
    expect(result.current.runtimes.map((row) => row.key)).toEqual(["builtin"])
    expect(result.current.selected?.derivedAdapter).toBe("claude-agent-sdk")
  })

  it("resolves the selection through the ref rather than a separate field", () => {
    externalState.agents = { a1: agent("a1", "Codex") }
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    const { result } = renderHook(() => useAgentRuntimeCatalog())
    expect(result.current.selected?.name).toBe("Codex")
  })

  it("resolves against the SESSION's lane, not the app default", () => {
    // The runtime chip writes the session's ref and reads `selected` back from
    // here. Resolving against the default made the radio group answer with the
    // row the user had just left, so the chip looked like it refused to move.
    externalState.agents = { a1: agent("a1", "Codex") }
    runtimeState.runtimeRef = { kind: "builtin" }
    runtimeState.sessionRuntimeRefs = { "chat-1": { kind: "external", agentId: "a1" } }
    const { result } = renderHook(() => useAgentRuntimeCatalog(undefined, "chat-1"))
    expect(result.current.selected?.name).toBe("Codex")
  })

  it("falls back to the app default for a session that never chose one", () => {
    externalState.agents = { a1: agent("a1", "Codex") }
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    runtimeState.sessionRuntimeRefs = {}
    const { result } = renderHook(() => useAgentRuntimeCatalog(undefined, "chat-untouched"))
    expect(result.current.selected?.name).toBe("Codex")
  })

  it("reports no selection for a ref whose agent is gone", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "deleted" }
    const { result } = renderHook(() => useAgentRuntimeCatalog())
    expect(result.current.selected).toBeUndefined()
  })

  it("translates a validity snapshot into the row's warning", () => {
    externalState.agents = { a1: agent("a1", "Codex") }
    externalState.agentValidity = { a1: { executable: true, negotiation: { authRequired: true } } }
    const { result } = renderHook(() => useAgentRuntimeCatalog())
    expect(result.current.runtimes[1].warning).toBe("needsAuth")
  })

  it("shows the runtime's own wording for a failed start, not a paraphrase", () => {
    externalState.agents = { a1: agent("a1", "Codex") }
    externalState.agentValidity = {
      a1: { executable: false, blockingReason: "codex: command not found" },
    }
    const { result } = renderHook(() => useAgentRuntimeCatalog())
    expect(result.current.runtimes[1].warning).toBe("codex: command not found")
  })

  it("counts configured agents even while the master switch hides them", () => {
    externalState.enabled = false
    externalState.agents = { a1: agent("a1", "Codex") }
    const { result } = renderHook(() => useAgentRuntimeCatalog())
    expect(result.current.runtimes.map((row) => row.key)).toEqual(["builtin"])
    expect(result.current.configuredExternalCount).toBe(1)
    expect(result.current.externalEnabled).toBe(false)
  })

  it("contributes no host rows when no host owns configurations", () => {
    hostState.configs = [
      {
        configId: "eac_1",
        revision: "r",
        lifecycleGeneration: 1,
        enabled: true,
        lifecycleStatus: "ready",
        config: { name: "Pi" },
      },
    ]
    hostState.unavailable = "no-host"
    const { result } = renderHook(() => useAgentRuntimeCatalog())
    expect(result.current.runtimes.map((row) => row.key)).toEqual(["builtin"])
  })
})
