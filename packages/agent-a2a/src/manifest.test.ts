import { requiresReconnectAfterCancel } from "@cognia/agent-contracts/semantics"
import { A2A_EXECUTION_SEMANTICS, A2A_PROTOCOL } from "./manifest"

describe("A2A manifest", () => {
  it("declares a remote agent whose task cancel keeps the context", () => {
    expect(A2A_PROTOCOL).toBe("a2a")
    expect(Object.isFrozen(A2A_EXECUTION_SEMANTICS)).toBe(true)
    expect(A2A_EXECUTION_SEMANTICS.processModel).toBe("remote")
    expect(requiresReconnectAfterCancel(A2A_EXECUTION_SEMANTICS)).toBe(false)
  })
})
