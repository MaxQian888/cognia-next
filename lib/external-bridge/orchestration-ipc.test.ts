/** @jest-environment jsdom */

import {
  ORCHESTRATION_EXEC_EVENT,
  installOrchestrationDispatchSource,
  subscribeOrchestrationExec,
  sendOrchestrationResponse,
} from "./orchestration-ipc"

const listenMock = jest.fn()
const invokeMock = jest.fn()
const runOrchestrationExecMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
jest.mock("./handlers/orchestration", () => ({
  runOrchestrationExec: (...args: unknown[]) => runOrchestrationExecMock(...args),
}))

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  })
  listenMock.mockReset().mockResolvedValue(() => {})
  invokeMock.mockReset().mockResolvedValue(undefined)
  runOrchestrationExecMock.mockReset()
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

  it("installs the shared request/response dispatcher on an injected host bridge", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined
    const unlisten = jest.fn()
    const bridge = {
      listen: jest.fn(async (_event: string, next: (event: { payload: unknown }) => void) => {
        handler = next
        return unlisten
      }),
      invoke: jest.fn(async () => undefined),
    }
    runOrchestrationExecMock.mockResolvedValue({ runId: "run-1", status: "pending" })

    const uninstall = await installOrchestrationDispatchSource({ bridge })
    handler!({
      payload: {
        id: "request-1",
        command: "workflowRunCreate",
        args: { arguments: [{ deploymentId: "deployment-1" }] },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runOrchestrationExecMock).toHaveBeenCalledWith("workflowRunCreate", {
      arguments: [{ deploymentId: "deployment-1" }],
    })
    expect(bridge.invoke).toHaveBeenCalledWith("orchestration_proxy_response", {
      id: "request-1",
      ok: true,
      result: { runId: "run-1", status: "pending" },
      error: undefined,
    })
    uninstall()
    expect(unlisten).toHaveBeenCalled()
  })

  it("turns dispatch failures into an ok:false proxy response", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined
    const bridge = {
      listen: jest.fn(async (_event: string, next: (event: { payload: unknown }) => void) => {
        handler = next
        return () => undefined
      }),
      invoke: jest.fn(async () => undefined),
    }
    runOrchestrationExecMock.mockRejectedValue(new Error("host unavailable"))

    await installOrchestrationDispatchSource({ bridge })
    handler!({ payload: { id: "request-2", command: "workflowRunGet", args: {} } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(bridge.invoke).toHaveBeenCalledWith(
      "orchestration_proxy_response",
      expect.objectContaining({ id: "request-2", ok: false, error: "host unavailable" })
    )
  })
})
