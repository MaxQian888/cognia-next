import {
  ORCHESTRATION_EXEC_EVENT,
  subscribeOrchestrationExec,
  sendOrchestrationResponse,
} from "./orchestration-ipc"

const subscribeMock = jest.fn()
const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: {
    subscribe: (...a: unknown[]) => subscribeMock(...a),
    call: (...a: unknown[]) => callMock(...a),
  },
}))

beforeEach(() => {
  subscribeMock.mockReset().mockResolvedValue(() => {})
  callMock.mockReset().mockResolvedValue(undefined)
})

describe("orchestration-ipc", () => {
  it("subscribes to the orchestration exec event", async () => {
    const handler = jest.fn()
    await subscribeOrchestrationExec(handler)
    expect(subscribeMock).toHaveBeenCalledWith(ORCHESTRATION_EXEC_EVENT, handler)
  })

  it("posts the reply back through the orchestration_proxy_response command", async () => {
    await sendOrchestrationResponse({ id: "r1", ok: true, result: { text: "x" } })
    expect(callMock).toHaveBeenCalledWith("orchestration_proxy_response", {
      id: "r1",
      ok: true,
      result: { text: "x" },
      error: undefined,
    })
  })

  it("carries the error field on a failure reply", async () => {
    await sendOrchestrationResponse({ id: "r2", ok: false, error: "boom" })
    expect(callMock).toHaveBeenCalledWith(
      "orchestration_proxy_response",
      expect.objectContaining({ id: "r2", ok: false, error: "boom" })
    )
  })
})
