import { recordPluginApiAudit } from "./interface-catalog"
import { PluginApiPolicyError, withGovernedPluginContext } from "./governed-context"

jest.mock("./interface-catalog", () => {
  const actual = jest.requireActual("./interface-catalog")
  return { ...actual, recordPluginApiAudit: jest.fn() }
})

const audit = jest.mocked(recordPluginApiAudit)

describe("withGovernedPluginContext", () => {
  beforeEach(() => audit.mockClear())

  it("preserves results and audits metadata for nested catalog methods", async () => {
    const context = withGovernedPluginContext(
      { session: { listSessions: async () => ["session"] } },
      { pluginId: "demo", hasPermission: () => true }
    )

    await expect(context.session.listSessions()).resolves.toEqual(["session"])
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "demo",
        methodId: "session.listSessions",
        outcome: "allowed",
      })
    )
    expect(audit.mock.calls[0][0]).not.toHaveProperty("args")
  })

  it("keeps shadow permission decisions behavior-compatible", () => {
    const fn = jest.fn(() => "ok")
    const context = withGovernedPluginContext(
      { auth: { registerProvider: fn } },
      { pluginId: "demo", hasPermission: () => false }
    )

    expect(context.auth.registerProvider()).toBe("ok")
    expect(fn).toHaveBeenCalled()
  })

  it("fails closed for methods missing from the catalog", () => {
    const context = withGovernedPluginContext(
      { session: { futureMethod: () => "unsafe" } },
      { pluginId: "demo", hasPermission: () => true }
    )

    expect(() => context.session.futureMethod()).toThrow(PluginApiPolicyError)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ methodId: "session.futureMethod", outcome: "denied" })
    )
  })

  it("preserves class instances instead of proxying their methods", () => {
    class HostHandle {
      close() {}
    }
    const handle = new HostHandle()
    const context = withGovernedPluginContext(
      { capabilities: { handle } },
      { pluginId: "demo", hasPermission: () => true }
    )

    expect(context.capabilities.handle).toBe(handle)
  })
})
