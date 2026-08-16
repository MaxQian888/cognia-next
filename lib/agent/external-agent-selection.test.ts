/**
 * @jest-environment jsdom
 */

import {
  clearExternalAgentSelectionIfActive,
  selectExternalAgent,
} from "./external-agent-selection"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

function selection() {
  return {
    runtime: useAgentRuntimeStore.getState().externalAgentId,
    external: useExternalAgentStore.getState().activeAgentId,
  }
}

beforeEach(() => {
  useAgentRuntimeStore.getState().setExternalAgentId(null)
  useExternalAgentStore.getState().setActiveAgent(null)
})

describe("selectExternalAgent", () => {
  // The point of the module: chat dispatch reads the runtime store while the
  // manager UI reads the external-agent store, so a selection that lands in
  // only one of them is a UI that lies about where the next turn goes.
  it("points both stores at the same agent", () => {
    selectExternalAgent("agent-1")
    expect(selection()).toEqual({ runtime: "agent-1", external: "agent-1" })
  })

  it("clears both stores", () => {
    selectExternalAgent("agent-1")
    selectExternalAgent(null)
    expect(selection()).toEqual({ runtime: null, external: null })
  })

  it("does not switch the runtime lane", () => {
    useAgentRuntimeStore.getState().setRuntime("claude-sdk")
    selectExternalAgent("agent-1")
    // Picking an agent in the manager must not reroute a chat that is running
    // on the built-in runtime.
    expect(useAgentRuntimeStore.getState().runtime).toBe("claude-sdk")
  })
})

describe("clearExternalAgentSelectionIfActive", () => {
  it("clears both stores when the removed agent is the selected one", () => {
    selectExternalAgent("agent-1")
    clearExternalAgentSelectionIfActive("agent-1")
    expect(selection()).toEqual({ runtime: null, external: null })
  })

  it("leaves a different selection alone", () => {
    selectExternalAgent("agent-1")
    clearExternalAgentSelectionIfActive("agent-2")
    expect(selection()).toEqual({ runtime: "agent-1", external: "agent-1" })
  })

  // The two stores can be out of sync from a persisted state written before
  // this module existed; clearing must then still fix the half that matches.
  it("clears whichever store holds the removed agent", () => {
    useAgentRuntimeStore.getState().setExternalAgentId("agent-1")
    useExternalAgentStore.getState().setActiveAgent("agent-2")
    clearExternalAgentSelectionIfActive("agent-1")
    expect(selection()).toEqual({ runtime: null, external: "agent-2" })
  })
})
