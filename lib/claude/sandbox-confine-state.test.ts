import {
  __resetSandboxConfineStateForTesting,
  clearActiveSandboxConfine,
  getActiveSandboxConfine,
  setActiveSandboxConfine,
} from "./sandbox-confine-state"

beforeEach(() => {
  __resetSandboxConfineStateForTesting()
})

describe("sandbox-confine-state", () => {
  it("stores and reads a confine per session", () => {
    setActiveSandboxConfine("s1", { network: "allowlist", networkHosts: ["api.github.com"] })
    expect(getActiveSandboxConfine("s1")).toEqual({
      network: "allowlist",
      networkHosts: ["api.github.com"],
    })
    expect(getActiveSandboxConfine("s2")).toBeNull()
  })

  it("clears when passed null and via clearActiveSandboxConfine", () => {
    setActiveSandboxConfine("s1", { network: "off" })
    setActiveSandboxConfine("s1", null)
    expect(getActiveSandboxConfine("s1")).toBeNull()

    setActiveSandboxConfine("s2", { network: "on" })
    clearActiveSandboxConfine("s2")
    expect(getActiveSandboxConfine("s2")).toBeNull()
  })

  it("ignores an empty session id on read and write", () => {
    setActiveSandboxConfine(undefined, { network: "on" })
    expect(getActiveSandboxConfine(undefined)).toBeNull()
  })
})
