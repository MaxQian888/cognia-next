/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { setAgentExecutionFlag } from "@/lib/ai/agent/execution/feature-flags"
import { useAgentExecutionFlag } from "./use-agent-execution-flag"

describe("useAgentExecutionFlag", () => {
  beforeEach(() => localStorage.clear())

  it("reacts to same-tab execution flag changes", () => {
    const { result } = renderHook(() => useAgentExecutionFlag("agentTeamRemoteDispatch"))
    expect(result.current).toBe(false)
    act(() => setAgentExecutionFlag("agentTeamRemoteDispatch", true))
    expect(result.current).toBe(true)
  })
})
