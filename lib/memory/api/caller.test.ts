import {
  cliCaller,
  companionCaller,
  internalJobCaller,
  localUserCaller,
  mcpCaller,
  pluginCaller,
  workflowCaller,
} from "./caller"

describe("memory caller constructors", () => {
  it("bind the account-owner principals for in-process transports", () => {
    expect(localUserCaller()).toEqual({ principalId: "local-user", transport: "local-ui" })
    expect(cliCaller()).toEqual({ principalId: "cli:tui", transport: "cli" })
    expect(mcpCaller()).toEqual({ principalId: "mcp:bridge", transport: "mcp" })
  })

  it("namespaces a plugin principal by the manager-injected id", () => {
    expect(pluginCaller("my-plugin")).toEqual({
      principalId: "plugin:my-plugin",
      transport: "plugin",
    })
  })

  it("binds a companion principal to the injected device id", () => {
    expect(companionCaller("dev-1")).toEqual({
      principalId: "companion:dev-1",
      transport: "companion",
    })
  })

  it("degrades to the transport principal when the route injects no device id", () => {
    expect(companionCaller()).toEqual({
      principalId: "companion:device",
      transport: "companion",
    })
    expect(companionCaller(undefined)).toEqual(companionCaller())
  })

  it("namespaces a workflow principal by run id when bound to one", () => {
    expect(workflowCaller("run-7")).toEqual({
      principalId: "workflow:run-7",
      transport: "workflow",
    })
    expect(workflowCaller()).toEqual({ principalId: "workflow", transport: "workflow" })
  })

  it("binds an internal job principal by worker id", () => {
    expect(internalJobCaller("w-3")).toEqual({
      principalId: "job:w-3",
      transport: "internal-job",
    })
  })

  it("never grants namespaces — the account-scope default until grants land", () => {
    for (const caller of [
      localUserCaller(),
      cliCaller(),
      mcpCaller(),
      pluginCaller("p"),
      companionCaller("d"),
      workflowCaller("r"),
      internalJobCaller("w"),
    ]) {
      expect(caller.namespaces).toBeUndefined()
    }
  })
})
