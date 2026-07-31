/** @jest-environment jsdom */

import {
  ORCHESTRATION_EXEC_EVENT,
  subscribeOrchestrationExec,
  sendOrchestrationResponse,
} from "./orchestration-ipc"

const listenMock = jest.fn()
const invokeMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  })
  listenMock.mockReset().mockResolvedValue(() => {})
  invokeMock.mockReset().mockResolvedValue(undefined)
})

describe("orchestration-ipc", () => {
  it("subscribes to the orchestration exec event", async () => {
    const handler = jest.fn()
    await subscribeOrchestrationExec(handler)
    expect(listenMock).toHaveBeenCalledWith(ORCHESTRATION_EXEC_EVENT, expect.any(Function))
  })

  it("does not project host-local execution events in a web controller", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
    const unlisten = await subscribeOrchestrationExec(jest.fn())

    expect(listenMock).not.toHaveBeenCalled()
    expect(() => unlisten()).not.toThrow()
  })

  it("posts the reply back through the orchestration_proxy_response command", async () => {
    await sendOrchestrationResponse({ id: "r1", ok: true, result: { text: "x" } })
    expect(invokeMock).toHaveBeenCalledWith("orchestration_proxy_response", {
      id: "r1",
      ok: true,
      result: { text: "x" },
      error: undefined,
    })
  })

  it("carries the error field on a failure reply", async () => {
    await sendOrchestrationResponse({ id: "r2", ok: false, error: "boom" })
    expect(invokeMock).toHaveBeenCalledWith(
      "orchestration_proxy_response",
      expect.objectContaining({ id: "r2", ok: false, error: "boom" })
    )
  })
})
