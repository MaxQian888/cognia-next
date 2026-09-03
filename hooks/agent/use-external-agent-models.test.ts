/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import type { ExternalAgentModelSurface } from "@/lib/ai/agent/external/session-models"

let runtimeRef: AgentRuntimeRef = { kind: "builtin" } as AgentRuntimeRef
const loadAgentModelSurface = jest.fn()
const cachedAgentModelSurface = jest.fn().mockReturnValue(null)
const loadAgentModelCatalog = jest.fn().mockResolvedValue({
  status: "unsupported",
  surface: { choices: [], currentModelId: null, write: { kind: "none" } },
})
const resolveConversationSessionId = jest.fn()
const selectSessionModel = jest.fn()

jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => runtimeRef,
}))
// The cache is a module singleton with a revision counter and a listener set.
// Both are read through `useSyncExternalStore`, so a mock that omits them does
// not merely lose coverage, it makes every test in this file throw at render.
let cacheRevision = 0
const cacheListeners = new Set<() => void>()
jest.mock("@/lib/ai/agent/external/model-surface-cache", () => ({
  loadAgentModelSurface: (...args: unknown[]) => loadAgentModelSurface(...args),
  cachedAgentModelSurface: (...args: unknown[]) => cachedAgentModelSurface(...args),
  loadAgentModelCatalog: (...args: unknown[]) => loadAgentModelCatalog(...args),
  subscribeAgentModelSurface: (listener: () => void) => {
    cacheListeners.add(listener)
    return () => cacheListeners.delete(listener)
  },
  agentModelSurfaceRevision: () => cacheRevision,
  AGENT_MODEL_CATALOG: "*catalog*",
  EMPTY_MODEL_SURFACE: { choices: [], currentModelId: null, write: { kind: "none" } },
}))
jest.mock("@/lib/ai/agent/external/process-plane", () => ({
  externalAgentProcessPlaneScope: () => "local",
  subscribeExternalAgentProcessPlane: () => () => {},
}))
const mountHostConfigForCatalog = jest.fn()
jest.mock("@/lib/ai/agent/external/host-config-mount", () => ({
  mountHostConfigForCatalog: (...args: unknown[]) => mountHostConfigForCatalog(...args),
}))
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    resolveConversationSessionId: (...args: unknown[]) => resolveConversationSessionId(...args),
    selectSessionModel: (...args: unknown[]) => selectSessionModel(...args),
  }),
}))

import { useExternalAgentModels } from "./use-external-agent-models"

const SURFACE: ExternalAgentModelSurface = {
  choices: [
    { modelId: "anthropic/sonnet", name: "Sonnet" },
    { modelId: "openai/gpt-5", name: "GPT-5" },
  ],
  currentModelId: "anthropic/sonnet",
  write: { kind: "config-option", optionId: "model" },
}

describe("useExternalAgentModels", () => {
  beforeEach(() => {
    runtimeRef = { kind: "external", agentId: "pi-1" } as AgentRuntimeRef
    loadAgentModelSurface.mockReset().mockResolvedValue({ status: "ready", surface: SURFACE })
    cachedAgentModelSurface.mockReset().mockReturnValue(null)
    resolveConversationSessionId.mockReset().mockReturnValue("sess-1")
    selectSessionModel.mockReset().mockResolvedValue(undefined)
    mountHostConfigForCatalog.mockReset().mockResolvedValue("eac_1")
    cacheRevision = 0
    cacheListeners.clear()
  })

  it("stays inert on a built-in lane", async () => {
    runtimeRef = { kind: "builtin" } as AgentRuntimeRef
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.agentId).toBeNull())
    expect(loadAgentModelSurface).not.toHaveBeenCalled()
    expect(result.current.surface).toBeNull()
  })

  it("asks the agent as soon as the lane is external, without waiting for a push", async () => {
    // ACP agents push `config_options_update`, so they worked by luck. Pi is
    // pull-based and pushed nothing, which is why the picker was empty.
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.surface).toEqual(SURFACE))
    expect(loadAgentModelSurface).toHaveBeenCalledWith("pi-1", "sess-1", { refresh: false })
    expect(resolveConversationSessionId).toHaveBeenCalledWith("pi-1", "chat-1")
    expect(result.current.status).toBe("ready")
  })

  it("does not ask when the agent has no session open yet", async () => {
    // Connected with nothing open is ordinary right after connecting, and is
    // not the same as "this agent has no models".
    resolveConversationSessionId.mockReturnValue(null)
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.externalSessionId).toBeNull())
    expect(loadAgentModelSurface).not.toHaveBeenCalled()
    // The session-less catalog IS asked for, and an agent that cannot answer
    // leaves the surface null rather than "no models".
    await waitFor(() =>
      expect(loadAgentModelCatalog).toHaveBeenCalledWith("pi-1", { refresh: false })
    )
    expect(result.current.surface).toBeNull()
  })

  it("seeds the picker from the catalog when the agent can list models without a session", async () => {
    resolveConversationSessionId.mockReturnValue(null)
    loadAgentModelCatalog.mockResolvedValueOnce({
      status: "ready",
      surface: {
        choices: [{ modelId: "deepseek/deepseek-v4-pro", name: "deepseek/deepseek-v4-pro" }],
        currentModelId: null,
        write: { kind: "session-seed" },
      },
    })
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.surface?.choices).toHaveLength(1))
    // A catalog pick is recorded by the caller and replayed on the first turn:
    // nothing is sent to an agent that has no session to receive it.
    await expect(result.current.select("deepseek/deepseek-v4-pro")).resolves.toBeUndefined()
    expect(selectSessionModel).not.toHaveBeenCalled()
  })

  it("keeps the surface null when the agent cannot answer", async () => {
    loadAgentModelSurface.mockResolvedValue({
      status: "unsupported",
      surface: { choices: [], currentModelId: null, write: { kind: "none" } },
    })
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.status).toBe("unsupported"))
    expect(result.current.surface).toBeNull()
  })

  it("writes a selection through the agent, then re-reads what it now reports", async () => {
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.surface).toEqual(SURFACE))

    await act(async () => {
      await result.current.select("openai/gpt-5")
    })

    expect(selectSessionModel).toHaveBeenCalledWith("pi-1", "sess-1", SURFACE, "openai/gpt-5")
    // Re-read rather than patched: setting a model can move more than the
    // model, and a hand-patched copy would hide that.
    expect(loadAgentModelSurface).toHaveBeenLastCalledWith("pi-1", "sess-1", { refresh: true })
  })

  it("refuses to write when the agent never answered, and says so", async () => {
    // Rejecting rather than resolving: a silent return looks like a completed
    // write to the caller, which keeps its optimistic chip and its persisted
    // session row while the agent was never told anything.
    loadAgentModelSurface.mockResolvedValue({
      status: "error",
      surface: { choices: [], currentModelId: null, write: { kind: "none" } },
      detail: "gone",
    })
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.status).toBe("error"))

    await act(async () => {
      await expect(result.current.select("openai/gpt-5")).rejects.toThrow(/no open session/i)
    })
    expect(selectSessionModel).not.toHaveBeenCalled()
  })

  it("does not leave the picker asking forever after a lane switch", async () => {
    // The run that was abandoned mid-flight raised `loading`, and the run that
    // replaces it answers from cache and returns without lowering it. The
    // picker then renders "asking the agent" for the rest of the conversation.
    let settle: (value: unknown) => void = () => {}
    loadAgentModelSurface.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    const { result, rerender } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.loading).toBe(true))

    // Off the external lane, then back onto it with a warm cache.
    runtimeRef = { kind: "builtin" } as AgentRuntimeRef
    rerender()
    await act(async () => {
      settle({ status: "ready", surface: SURFACE })
    })
    cachedAgentModelSurface.mockReturnValue({ status: "ready", surface: SURFACE })
    runtimeRef = { kind: "external", agentId: "pi-1" } as AgentRuntimeRef
    rerender()

    await waitFor(() => expect(result.current.surface).toEqual(SURFACE))
    expect(result.current.loading).toBe(false)
  })

  // The host lane answered IDLE, so the picker offered no models and no
  // thinking ladder for an agent that has both, and every turn ran on whatever
  // the agent defaults to.
  describe("a configuration the paired host owns", () => {
    beforeEach(() => {
      runtimeRef = {
        kind: "host",
        configId: "eac_1",
        revision: "eacr_1",
        lifecycleGeneration: 1,
      } as AgentRuntimeRef
      resolveConversationSessionId.mockReturnValue(null)
      loadAgentModelCatalog.mockReset().mockResolvedValue({ status: "ready", surface: SURFACE })
    })

    it("mounts the host's configuration and reads its catalog", async () => {
      const { result } = renderHook(() => useExternalAgentModels("chat-1"))
      await waitFor(() => expect(result.current.surface).toEqual(SURFACE))
      expect(mountHostConfigForCatalog).toHaveBeenCalledWith("eac_1")
      // The configuration id IS the agent id, which is what lets the picker
      // stamp a persisted model with the same marker the local lane uses.
      expect(result.current.agentId).toBe("eac_1")
      expect(loadAgentModelCatalog).toHaveBeenCalledWith("eac_1", { refresh: false })
    })

    // A conversation can outlive the configuration it was bound to.
    it("shows nothing, without failing, when the host no longer has it", async () => {
      mountHostConfigForCatalog.mockResolvedValue(null)
      const { result } = renderHook(() => useExternalAgentModels("chat-1"))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.surface).toBeNull()
      expect(loadAgentModelCatalog).not.toHaveBeenCalled()
    })

    // Reported as an error rather than left to fall through: without the mount
    // the catalog read finds no adapter and answers `unsupported`, which reads
    // as "this agent has no models" about an agent that was never asked.
    it("says the mount was refused instead of claiming the agent has no models", async () => {
      mountHostConfigForCatalog.mockRejectedValue(new Error("Agent Control was never granted"))
      const { result } = renderHook(() => useExternalAgentModels("chat-1"))
      await waitFor(() => expect(result.current.status).toBe("error"))
      expect(result.current.surface).toBeNull()
      expect(loadAgentModelCatalog).not.toHaveBeenCalled()
    })
  })

  it("re-asks on refresh", async () => {
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.surface).toEqual(SURFACE))

    act(() => result.current.refresh())
    await waitFor(() =>
      expect(loadAgentModelSurface).toHaveBeenLastCalledWith("pi-1", "sess-1", { refresh: true })
    )
  })
})
