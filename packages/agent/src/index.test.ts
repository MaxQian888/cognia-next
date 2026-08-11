import * as agent from "./index"

describe("@cognia/agent exports", () => {
  it("exports only the standalone client runtime values", () => {
    expect(typeof agent.createCogniaClient).toBe("function")
    expect(agent.HostNotFoundError).toBeInstanceOf(Function)
    expect(agent.IncompatibleHostError).toBeInstanceOf(Function)
    expect(agent.RpcError).toBeInstanceOf(Function)
    expect(agent).not.toHaveProperty("createCogniaRuntime")
    expect(agent).not.toHaveProperty("createRpcServer")
  })
})
