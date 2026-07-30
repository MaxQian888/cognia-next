import { isRemoteExecutionContext } from "./remote-execution"

describe("remote execution context", () => {
  const valid = {
    hostId: "host-a",
    originDeviceId: "device-a",
    sessionId: "session-a",
    generation: 2,
    requestId: "request-a",
    issuedAt: 100,
    expiresAt: 200,
  }

  it("accepts a complete request-scoped identity envelope", () => {
    expect(isRemoteExecutionContext(valid)).toBe(true)
  })

  it("rejects malformed, expired-at-issue, and generation-free envelopes", () => {
    expect(isRemoteExecutionContext({ ...valid, originDeviceId: undefined })).toBe(false)
    expect(isRemoteExecutionContext({ ...valid, generation: 0 })).toBe(false)
    expect(isRemoteExecutionContext({ ...valid, expiresAt: 99 })).toBe(false)
  })
})
