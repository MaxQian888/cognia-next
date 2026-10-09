/**
 * @jest-environment jsdom
 */

jest.mock("@/stores/agent/agent-runtime-store", () => ({ useRuntimeRefForSession: jest.fn() }))
jest.mock("@/stores/agent/external-agent-store", () => ({ useExternalAgentStore: jest.fn() }))
jest.mock("@/lib/agents/builder/runtime-tool-support", () => {
  const actual = jest.requireActual<typeof import("@/lib/agents/builder/runtime-tool-support")>(
    "@/lib/agents/builder/runtime-tool-support"
  )
  return { ...actual, runtimeToolSupport: jest.fn(actual.runtimeToolSupport) }
})

import { renderHook } from "@testing-library/react"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { runtimeToolSupport } from "@/lib/agents/builder/runtime-tool-support"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useBuilderToolSupport } from "./use-builder-tool-support"

const refMock = useRuntimeRefForSession as jest.Mock
const storeMock = useExternalAgentStore as unknown as jest.Mock
const supportMock = runtimeToolSupport as jest.Mock

let agents: Record<string, { protocol?: string }> = {}

beforeEach(() => {
  jest.clearAllMocks()
  agents = {}
  storeMock.mockImplementation((selector: (state: { agents: typeof agents }) => unknown) =>
    selector({ agents })
  )
})

const HOST: AgentRuntimeRef = {
  kind: "host",
  configId: "cfg",
  revision: "r1",
  lifecycleGeneration: 1,
}

describe("useBuilderToolSupport", () => {
  it("reads the runtime of the given session", () => {
    refMock.mockReturnValue({ kind: "builtin" })
    renderHook(() => useBuilderToolSupport("sess-1"))
    expect(refMock).toHaveBeenCalledWith("sess-1")
  })

  it("passes an absent session through to the runtime lookup", () => {
    refMock.mockReturnValue({ kind: "builtin" })
    renderHook(() => useBuilderToolSupport(undefined))
    expect(refMock).toHaveBeenCalledWith(undefined)
  })

  it("is supported on the built-in lane", () => {
    refMock.mockReturnValue({ kind: "builtin" })
    const { result } = renderHook(() => useBuilderToolSupport("s"))
    expect(result.current).toBe("supported")
  })

  it("is supported for an external agent whose protocol carries MCP", () => {
    refMock.mockReturnValue({ kind: "external", agentId: "a1" })
    agents = { a1: { protocol: "acp" } }
    const { result } = renderHook(() => useBuilderToolSupport("s"))
    expect(result.current).toBe("supported")
  })

  it("hands the external agent's protocol to the support check", () => {
    refMock.mockReturnValue({ kind: "external", agentId: "a1" })
    agents = { a1: { protocol: "some-protocol" } }
    supportMock.mockReturnValueOnce("unsupported")
    const { result } = renderHook(() => useBuilderToolSupport("s"))
    expect(result.current).toBe("unsupported")
    const [ref, protocolOf] = supportMock.mock.calls[0] as [
      AgentRuntimeRef,
      (target: AgentRuntimeRef) => string | undefined,
    ]
    expect(ref).toEqual({ kind: "external", agentId: "a1" })
    expect(protocolOf({ kind: "external", agentId: "a1" })).toBe("some-protocol")
    expect(protocolOf(HOST)).toBeUndefined()
  })

  it("is unknown for an external agent missing from the store", () => {
    refMock.mockReturnValue({ kind: "external", agentId: "gone" })
    const { result } = renderHook(() => useBuilderToolSupport("s"))
    expect(result.current).toBe("unknown")
  })

  it("is unknown for a host configuration and never reads an external protocol for it", () => {
    refMock.mockReturnValue(HOST)
    agents = { cfg: { protocol: "acp" } }
    const { result } = renderHook(() => useBuilderToolSupport("s"))
    expect(result.current).toBe("unknown")
    const selector = storeMock.mock.calls[0][0] as (state: { agents: typeof agents }) => unknown
    expect(selector({ agents })).toBeUndefined()
  })
})
