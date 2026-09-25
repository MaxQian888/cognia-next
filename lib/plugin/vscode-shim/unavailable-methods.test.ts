import { EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS } from "./unavailable-methods"
import { EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS as FROM_HANDLERS } from "./runtime-handlers"

describe("EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS", () => {
  it("is the same list the runtime handlers register refusals for", () => {
    expect(FROM_HANDLERS).toBe(EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS)
  })

  it("names each method once, as a `<namespace>:<method>` wire id", () => {
    expect(new Set(EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS).size).toBe(
      EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS.length
    )
    for (const method of EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS) {
      expect(method).toMatch(/^[a-zA-Z]+:[a-zA-Z]+$/)
    }
  })
})
