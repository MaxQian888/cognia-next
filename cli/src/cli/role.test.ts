/**
 * @jest-environment node
 */
import { selectRole } from "./role"

describe("selectRole", () => {
  it("returns 'sidecar' when COGNIA_ROLE=sidecar", () => {
    expect(selectRole({ COGNIA_ROLE: "sidecar" })).toBe("sidecar")
  })

  it("returns 'mcp-relay' for the packaged guarded relay", () => {
    expect(selectRole({ COGNIA_ROLE: "mcp-relay" })).toBe("mcp-relay")
  })

  it("routes compiled subprocess workers through dedicated roles", () => {
    expect(selectRole({ COGNIA_ROLE: "webclone" })).toBe("webclone")
    expect(selectRole({ COGNIA_ROLE: "run-code" })).toBe("run-code")
    expect(selectRole({ COGNIA_ROLE: "claude-probe" })).toBe("claude-probe")
    expect(selectRole({ COGNIA_ROLE: "codegraph-probe" })).toBe("codegraph-probe")
  })

  it("defaults to 'cli' when COGNIA_ROLE is unset", () => {
    expect(selectRole({})).toBe("cli")
  })

  it("defaults to 'cli' for any other COGNIA_ROLE value", () => {
    expect(selectRole({ COGNIA_ROLE: "" })).toBe("cli")
    expect(selectRole({ COGNIA_ROLE: "agent" })).toBe("cli")
  })
})
