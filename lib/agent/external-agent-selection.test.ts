/**
 * @jest-environment jsdom
 */

import {
  clearExternalAgentSelectionIfActive,
  selectExternalAgent,
} from "./external-agent-selection"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { BUILTIN_RUNTIME_REF } from "@/lib/ai/agent/runtime-catalog/types"

function selection() {
  const ref = useAgentRuntimeStore.getState().runtimeRef
  return {
    runtime: ref.kind === "external" ? ref.agentId : null,
    external: useExternalAgentStore.getState().activeAgentId,
  }
}

beforeEach(() => {
  useAgentRuntimeStore.getState().setRuntimeRef(BUILTIN_RUNTIME_REF)
  useExternalAgentStore.getState().setActiveAgent(null)
})

describe("selectExternalAgent", () => {
  // The point of the module: chat dispatch reads the runtime store while the
  // manager UI reads the external-agent store, so a selection that lands in
  // only one of them is a UI that lies about where the next turn goes.
  it("retargets an already-external lane in both stores", () => {
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "agent-0" })
    selectExternalAgent("agent-1")
    expect(selection()).toEqual({ runtime: "agent-1", external: "agent-1" })
  })

  it("does not switch the runtime lane", () => {
    selectExternalAgent("agent-1")
    // Picking an agent in the manager must not reroute a chat that is running
    // on Cognia's own runtime. Only the manager's own selection moves.
    expect(useAgentRuntimeStore.getState().runtimeRef).toEqual(BUILTIN_RUNTIME_REF)
    expect(useExternalAgentStore.getState().activeAgentId).toBe("agent-1")
  })

  it("clears the manager selection without touching the lane", () => {
    selectExternalAgent("agent-1")
    selectExternalAgent(null)
    expect(selection()).toEqual({ runtime: null, external: null })
  })
})

describe("clearExternalAgentSelectionIfActive", () => {
  it("drops the lane back to the default when the removed agent was running it", () => {
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "agent-1" })
    useExternalAgentStore.getState().setActiveAgent("agent-1")
    clearExternalAgentSelectionIfActive("agent-1")
    expect(useAgentRuntimeStore.getState().runtimeRef).toEqual(BUILTIN_RUNTIME_REF)
    expect(selection()).toEqual({ runtime: null, external: null })
  })

  it("leaves a different selection alone", () => {
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "agent-1" })
    useExternalAgentStore.getState().setActiveAgent("agent-1")
    clearExternalAgentSelectionIfActive("agent-2")
    expect(selection()).toEqual({ runtime: "agent-1", external: "agent-1" })
  })

  // The two stores can be out of sync from a persisted state written before
  // this module existed, so clearing must still fix the half that matches.
  it("clears whichever store holds the removed agent", () => {
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "agent-1" })
    useExternalAgentStore.getState().setActiveAgent("agent-2")
    clearExternalAgentSelectionIfActive("agent-1")
    expect(selection()).toEqual({ runtime: null, external: "agent-2" })
  })

  it("never touches the lane while it is on the builtin runtime", () => {
    useExternalAgentStore.getState().setActiveAgent("agent-1")
    clearExternalAgentSelectionIfActive("agent-1")
    expect(useAgentRuntimeStore.getState().runtimeRef).toEqual(BUILTIN_RUNTIME_REF)
    expect(useExternalAgentStore.getState().activeAgentId).toBeNull()
  })
})
