/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { recordedRuntimeRef, useSessionModelLanes } from "./use-session-model-lanes"

describe("useSessionModelLanes", () => {
  beforeEach(() => {
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "builtin" },
      sessionRuntimeRefs: { s1: { kind: "external", agentId: "kimi" } },
    })
    useExternalAgentStore.setState({ agents: {} })
  })

  it("reads this device's per-conversation lanes and its default", () => {
    const { result } = renderHook(() => useSessionModelLanes())
    expect(result.current.defaultRuntimeRef).toEqual({ kind: "builtin" })
    expect(result.current.sessionRuntimeRefs).toEqual({ s1: { kind: "external", agentId: "kimi" } })
  })

  it("names a locally configured agent, and nothing it does not know", () => {
    act(() => {
      useExternalAgentStore.setState({
        agents: { kimi: { id: "kimi", name: "Kimi Code" } } as never,
      })
    })
    const { result } = renderHook(() => useSessionModelLanes())
    expect(result.current.agentNameOf("kimi")).toBe("Kimi Code")
    expect(result.current.agentNameOf("codex")).toBeUndefined()
    // Not a prototype walk.
    expect(result.current.agentNameOf("toString")).toBeUndefined()
  })
})

describe("recordedRuntimeRef", () => {
  it("returns only what the device recorded for that conversation", () => {
    const refs = { s1: { kind: "builtin" } as const }
    expect(recordedRuntimeRef(refs, "s1")).toEqual({ kind: "builtin" })
    expect(recordedRuntimeRef(refs, "s2")).toBeUndefined()
    expect(recordedRuntimeRef(refs, "constructor")).toBeUndefined()
  })
})
