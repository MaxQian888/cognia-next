import * as protocol from "./protocol"

describe("@cognia/agent/protocol exports", () => {
  it("exports the v2 schema authority", () => {
    expect(protocol.RPC_PROTOCOL_VERSION).toBe(2)
    expect(Object.keys(protocol.rpcMethodSchemas)).toEqual(protocol.RPC_METHODS)
    expect(Object.keys(protocol.hostRequestSchemas)).toEqual(protocol.HOST_REQUEST_METHODS)
  })
})
