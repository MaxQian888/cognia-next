/**
 * @jest-environment node
 */
import { createPermissionGate } from "./permission-gate"
import type { PermissionRequestEvent } from "@/lib/claude/types"

function req(toolName: string): PermissionRequestEvent {
  return {
    type: "permission_request",
    sessionId: "s1",
    requestId: "r1",
    toolUseID: "u1",
    toolName,
    input: {},
  }
}

describe("createPermissionGate", () => {
  it("allows everything with yes", async () => {
    const gate = createPermissionGate({ yes: true })
    expect(await gate(req("write"))).toEqual({ decision: "allow" })
  })

  it("allows tools on the allowlist, denies others", async () => {
    const gate = createPermissionGate({ allow: ["write"] })
    expect((await gate(req("write"))).decision).toBe("allow")
    const denied = await gate(req("bash"))
    expect(denied.decision).toBe("deny")
    expect(denied.message).toMatch(/--allow bash/)
  })

  it("denies by default in headless mode (no yes / allow / prompt)", async () => {
    const gate = createPermissionGate({})
    expect((await gate(req("edit"))).decision).toBe("deny")
  })

  it("asks the interactive prompt for unmatched tools", async () => {
    const prompt = jest.fn().mockResolvedValue(true)
    const gate = createPermissionGate({ prompt })
    expect((await gate(req("bash"))).decision).toBe("allow")
    expect(prompt).toHaveBeenCalledWith(req("bash"))
  })

  it("denies when the interactive prompt rejects", async () => {
    const gate = createPermissionGate({ prompt: async () => false })
    expect((await gate(req("bash"))).decision).toBe("deny")
  })

  it("treats a throwing prompt as deny", async () => {
    const gate = createPermissionGate({
      prompt: async () => {
        throw new Error("ctrl-c")
      },
    })
    expect((await gate(req("bash"))).decision).toBe("deny")
  })

  it("yes takes precedence over a prompt", async () => {
    const prompt = jest.fn()
    const gate = createPermissionGate({ yes: true, prompt })
    expect((await gate(req("bash"))).decision).toBe("allow")
    expect(prompt).not.toHaveBeenCalled()
  })
})
