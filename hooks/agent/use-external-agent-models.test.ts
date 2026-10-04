/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import type { ExternalAgentModelSurface } from "@/lib/ai/agent/external/session/session-models"

let runtimeRef: AgentRuntimeRef = { kind: "builtin" } as AgentRuntimeRef
const loadAgentModelSurface = jest.fn()
const cachedAgentModelSurface = jest.fn().mockReturnValue(null)
const bindConversationSession = jest.fn()
const loadAgentModelCatalog = jest.fn().mockResolvedValue({
  status: "unsupported",
  surface: { choices: [], currentModelId: null, write: { kind: "none" } },
})
const cachedConversationSurface = jest.fn().mockReturnValue(null)
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
jest.mock("@/lib/ai/agent/external/capability/model-surface-cache", () => ({
  loadAgentModelSurface: (...args: unknown[]) => loadAgentModelSurface(...args),
  cachedAgentModelSurface: (...args: unknown[]) => cachedAgentModelSurface(...args),
  cachedConversationSurface: (...args: unknown[]) => cachedConversationSurface(...args),
  bindConversationSession: (...args: unknown[]) => bindConversationSession(...args),
  loadAgentModelCatalog: (...args: unknown[]) => loadAgentModelCatalog(...args),
  subscribeAgentModelSurface: (listener: () => void) => {
    cacheListeners.add(listener)
    return () => cacheListeners.delete(listener)
  },
  agentModelSurfaceRevision: () => cacheRevision,
  AGENT_MODEL_CATALOG: "*catalog*",
  EMPTY_MODEL_SURFACE: { choices: [], currentModelId: null, write: { kind: "none" } },
}))
jest.mock("@/lib/ai/agent/external/capability/process-plane", () => ({
  externalAgentProcessPlaneScope: () => "local",
  subscribeExternalAgentProcessPlane: () => () => {},
}))
const mountHostConfigForCatalog = jest.fn()
let mountIsLocal = true
jest.mock("@/lib/ai/agent/external/config/host-config-mount", () => ({
  mountHostConfigForCatalog: (...args: unknown[]) => mountHostConfigForCatalog(...args),
  hostConfigCatalogMountIsLocal: () => mountIsLocal,
}))
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    resolveConversationSessionId: (...args: unknown[]) => resolveConversationSessionId(...args),
    selectSessionModel: (...args: unknown[]) => selectSessionModel(...args),
  }),
}))

import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { MODEL_DISCOVERY_DEADLINE_MS, useExternalAgentModels } from "./use-external-agent-models"

const SURFACE: ExternalAgentModelSurface = {
  choices: [
    { modelId: "anthropic/sonnet", name: "Sonnet" },
    { modelId: "openai/gpt-5", name: "GPT-5" },
  ],
  currentModelId: "anthropic/sonnet",
  write: { kind: "config-option", optionId: "model" },
}

describe("useExternalAgentModels", () => {
  it("loads the catalog on the welcome screen before a conversation exists", async () => {
    const { result } = renderHook(() => useExternalAgentModels(undefined))
    await waitFor(() =>
      expect(loadAgentModelCatalog).toHaveBeenCalledWith("pi-1", { refresh: false })
    )
    expect(resolveConversationSessionId).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it("keeps catalog errors visible and lets refresh recover before the first turn", async () => {
    resolveConversationSessionId.mockReturnValue(null)
    loadAgentModelCatalog.mockResolvedValueOnce({
      status: "error",
      surface: null,
      detail: "offline",
    })
    const { result } = renderHook(() => useExternalAgentModels("chat-1"))
    await waitFor(() => expect(result.current.status).toBe("error"))
    loadAgentModelCatalog.mockResolvedValueOnce({ status: "ready", surface: SURFACE })
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.surface).toEqual(SURFACE))
    expect(loadAgentModelCatalog).toHaveBeenLastCalledWith("pi-1", { refresh: true })
  })
  beforeEach(() => {
    runtimeRef = { kind: "external", agentId: "pi-1" } as AgentRuntimeRef
    loadAgentModelSurface.mockReset().mockResolvedValue({ status: "ready", surface: SURFACE })
    cachedAgentModelSurface.mockReset().mockReturnValue(null)
    bindConversationSession.mockReset()
    resolveConversationSessionId.mockReset().mockReturnValue("sess-1")
    selectSessionModel.mockReset().mockResolvedValue(undefined)
    mountHostConfigForCatalog.mockReset().mockResolvedValue("eac_1")
    cachedConversationSurface.mockReset().mockReturnValue(null)
    mountIsLocal = true
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
    // The resolved session is published for readers with no hooks, so a plugin
    // dial reads the ladder of the same session this hook describes.
    expect(bindConversationSession).toHaveBeenCalledWith("pi-1", "chat-1", "sess-1")
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
    let resolveReplacementSession: (id: string) => void = () => {}
    resolveConversationSessionId.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveReplacementSession = resolve
      })
    )
    runtimeRef = { kind: "external", agentId: "pi-1" } as AgentRuntimeRef
    rerender()

    // The shared cache can render before this effect's session lookup settles.
    // A cached surface alone therefore does not establish loading completion.
    expect(result.current.surface).toEqual(SURFACE)
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(resolveConversationSessionId).toHaveBeenCalledTimes(2))
    await act(async () => resolveReplacementSession("sess-1"))
    await waitFor(() => {
      expect(result.current.surface).toEqual(SURFACE)
      expect(result.current.loading).toBe(false)
    })
    expect(loadAgentModelSurface).toHaveBeenCalledTimes(1)
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

    // A desktop or headless brain that owns its host-config store: the mount
    // shares the run service's agent, so reading the catalog spawns nothing.
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

  // A phone or browser paired to a Host. Mounting there spawned a SECOND copy
  // of the agent on the Host under the running copy's process id, and the
  // picker sat on "asking the agent" until that spawn timed out.
  describe("a configuration a paired Host runs for this client", () => {
    beforeEach(() => {
      runtimeRef = {
        kind: "host",
        configId: "eac_1",
        revision: "eacr_1",
        lifecycleGeneration: 1,
        name: "Kimi Code",
      } as AgentRuntimeRef
      mountIsLocal = false
    })

    it("never mounts or asks, and says the models arrive with a turn", async () => {
      const { result } = renderHook(() => useExternalAgentModels("chat-1"))
      await waitFor(() => expect(result.current.status).toBe("deferred"))
      expect(result.current.loading).toBe(false)
      expect(result.current.canRefresh).toBe(false)
      expect(result.current.surface).toBeNull()
      expect(result.current.agentName).toBe("Kimi Code")
      expect(mountHostConfigForCatalog).not.toHaveBeenCalled()
      expect(loadAgentModelCatalog).not.toHaveBeenCalled()
      expect(loadAgentModelSurface).not.toHaveBeenCalled()
      // Refresh has nobody to ask either.
      act(() => result.current.refresh())
      expect(mountHostConfigForCatalog).not.toHaveBeenCalled()
    })

    it("shows what the Host reported after a turn, and seeds a pick", async () => {
      const reported: ExternalAgentModelSurface = { ...SURFACE, write: { kind: "session-seed" } }
      const { result } = renderHook(() => useExternalAgentModels("chat-1"))
      await waitFor(() => expect(result.current.status).toBe("deferred"))

      cachedConversationSurface.mockReturnValue({ status: "ready", surface: reported })
      act(() => {
        cacheRevision += 1
        for (const listener of [...cacheListeners]) listener()
      })
      await waitFor(() => expect(result.current.surface).toEqual(reported))
      expect(cachedConversationSurface).toHaveBeenLastCalledWith("eac_1", "chat-1")
      // The Host applies the persisted pick on the next turn: nothing is sent.
      await expect(result.current.select("openai/gpt-5")).resolves.toBeUndefined()
      expect(selectSessionModel).not.toHaveBeenCalled()
    })
  })

  it("stops claiming to ask once discovery outlives its deadline", async () => {
    jest.useFakeTimers()
    try {
      loadAgentModelSurface.mockReturnValue(new Promise(() => {}))
      const { result } = renderHook(() => useExternalAgentModels("chat-1"))
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.loading).toBe(true)
      await act(async () => {
        jest.advanceTimersByTime(MODEL_DISCOVERY_DEADLINE_MS)
      })
      expect(result.current.loading).toBe(false)
      expect(result.current.status).toBe("error")
      expect(result.current.canRefresh).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it("names the agent from the local store", async () => {
    useExternalAgentStore.setState({
      agents: { "pi-1": { id: "pi-1", name: "Pi" } } as never,
    })
    try {
      const { result } = renderHook(() => useExternalAgentModels("chat-1"))
      await waitFor(() => expect(result.current.agentName).toBe("Pi"))
    } finally {
      useExternalAgentStore.setState({ agents: {} as never })
    }
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
