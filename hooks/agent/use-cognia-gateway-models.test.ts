/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import type {
  CogniaGatewayModelCatalog,
  CogniaGatewayProviderOption,
} from "@/lib/ai/agent/external/config/cognia-model-options"

let runtimeRef: AgentRuntimeRef = { kind: "builtin" } as AgentRuntimeRef
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => runtimeRef,
}))

const cogniaGatewaySupport = jest.fn()
jest.mock("@/lib/ai/agent/external/config/gateway-task", () => ({
  cogniaGatewaySupport: (...args: unknown[]) => cogniaGatewaySupport(...args),
}))
const listCogniaGatewayModelOptions = jest.fn()
jest.mock("@/lib/ai/agent/external/config/cognia-model-options", () => ({
  listCogniaGatewayModelOptions: (...args: unknown[]) => listCogniaGatewayModelOptions(...args),
}))
const fetchHostCogniaModels = jest.fn()
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-host-configs", () => ({
  fetchHostCogniaModels: (...args: unknown[]) => fetchHostCogniaModels(...args),
}))
const SUBSCRIPTIONS = [{ id: "plugin:kimi:subscription" }]
jest.mock("@/lib/subscription/core/hooks", () => ({
  useSubscriptionProviders: () => SUBSCRIPTIONS,
}))

import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useSettingsStore } from "@/stores/settings"
import { useCogniaGatewayModels } from "./use-cognia-gateway-models"

const PROVIDERS: CogniaGatewayProviderOption[] = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    models: [{ id: "claude-opus-5", name: "Claude Opus 5", supportsTools: true }],
  },
]

const SETTINGS = { providerSettings: {}, customProviders: [] }

beforeEach(() => {
  runtimeRef = { kind: "builtin" } as AgentRuntimeRef
  cogniaGatewaySupport.mockReset().mockReturnValue({ supported: true, runtime: "pi" })
  listCogniaGatewayModelOptions.mockReset().mockReturnValue(PROVIDERS)
  fetchHostCogniaModels.mockReset()
  act(() => {
    useSettingsStore.setState({ settings: SETTINGS as never })
    useExternalAgentStore.setState({
      agents: { "pi-1": { id: "pi-1", name: "Pi", protocol: "pi-rpc" } },
    } as never)
  })
})

afterEach(() => {
  act(() => {
    useSettingsStore.setState({ settings: undefined as never })
    useExternalAgentStore.setState({ agents: {} } as never)
  })
})

describe("on a built-in lane", () => {
  it("offers nothing and asks nobody", () => {
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    expect(result.current).toMatchObject({ agentId: null, lane: null, status: "idle" })
    expect(result.current.providers).toEqual([])
    expect(fetchHostCogniaModels).not.toHaveBeenCalled()
  })
})

describe("on a local agent's lane", () => {
  beforeEach(() => {
    runtimeRef = { kind: "external", agentId: "pi-1" } as AgentRuntimeRef
  })

  it("lists this client's eligible providers through the shared filter", () => {
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    expect(result.current).toMatchObject({
      agentId: "pi-1",
      lane: "local",
      status: "ready",
      reason: null,
      providers: PROVIDERS,
    })
    expect(cogniaGatewaySupport).toHaveBeenCalledWith(expect.objectContaining({ id: "pi-1" }))
    expect(listCogniaGatewayModelOptions).toHaveBeenCalledWith({
      settings: SETTINGS,
      subscriptions: SUBSCRIPTIONS,
    })
    expect(fetchHostCogniaModels).not.toHaveBeenCalled()
  })

  it("says why an agent whose runtime cannot be launched on the gateway cannot", () => {
    cogniaGatewaySupport.mockReturnValue({ supported: false, reason: "remote-server" })
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    expect(result.current).toMatchObject({ status: "unavailable", reason: "remote-server" })
    expect(result.current.providers).toEqual([])
    expect(listCogniaGatewayModelOptions).not.toHaveBeenCalled()
  })

  it("says so when no configured provider is eligible", () => {
    listCogniaGatewayModelOptions.mockReturnValue([])
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    expect(result.current).toMatchObject({ status: "unavailable", reason: "no-eligible-models" })
  })

  it("waits for an agent this client has not loaded yet", () => {
    runtimeRef = { kind: "external", agentId: "unknown" } as AgentRuntimeRef
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    expect(result.current).toMatchObject({ agentId: "unknown", lane: "local", status: "idle" })
  })
})

describe("on a Host-owned configuration's lane", () => {
  beforeEach(() => {
    runtimeRef = {
      kind: "host",
      configId: "eac_1",
      revision: "eacr_1",
      lifecycleGeneration: 1,
      name: "Kimi",
    } as AgentRuntimeRef
  })

  it("asks the Host, which owns the providers and accounts", async () => {
    fetchHostCogniaModels.mockResolvedValue({ supported: true, providers: PROVIDERS })
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    expect(result.current).toMatchObject({ agentId: "eac_1", lane: "host", status: "loading" })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.providers).toEqual(PROVIDERS)
    expect(fetchHostCogniaModels).toHaveBeenCalledWith("eac_1")
    expect(cogniaGatewaySupport).not.toHaveBeenCalled()
  })

  it.each<Extract<CogniaGatewayModelCatalog, { supported: false }>["reason"]>([
    "host-update-required",
    "account-locked",
    "public-https-required",
    "unsupported-runtime",
  ])("carries the Host's refusal (%s) as the reason", async (reason) => {
    fetchHostCogniaModels.mockResolvedValue({ supported: false, reason })
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.reason).toBe(reason)
  })

  it("reports a Host that offered no models as having none eligible", async () => {
    fetchHostCogniaModels.mockResolvedValue({ supported: true, providers: [] })
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.reason).toBe("no-eligible-models")
  })

  it("reports a failed ask as an error, and asks again on refresh", async () => {
    fetchHostCogniaModels.mockRejectedValueOnce(new Error("offline"))
    fetchHostCogniaModels.mockResolvedValue({ supported: true, providers: PROVIDERS })
    const { result } = renderHook(() => useCogniaGatewayModels("chat-1"))
    await waitFor(() => expect(result.current.status).toBe("error"))
    act(() => result.current.refresh())
    expect(result.current.status).toBe("loading")
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(fetchHostCogniaModels).toHaveBeenCalledTimes(2)
  })
})
