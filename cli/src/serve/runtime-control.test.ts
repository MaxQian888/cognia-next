import { HeadlessRuntimeControlError, type HeadlessRuntimeStatus } from "@/lib/headless/bootstrap"

import {
  answerRuntimeControl,
  installRuntimeControl,
  RUNTIME_CONTROL_REQUEST_EVENT,
  RUNTIME_CONTROL_RESPONSE_COMMAND,
} from "./runtime-control"

const running: HeadlessRuntimeStatus = {
  name: "connector-runtime",
  criticality: "optional",
  state: "running",
  restartable: true,
  restarts: 1,
  startedAt: 5,
}
const failed: HeadlessRuntimeStatus = {
  name: "room-runner",
  criticality: "required",
  state: "failed",
  error: "no backend",
  restartable: true,
  restarts: 0,
}

function runtimes(restart: (name: string) => Promise<HeadlessRuntimeStatus> = async () => running) {
  return { status: jest.fn(() => [running, failed]), restart: jest.fn(restart) }
}

describe("answerRuntimeControl", () => {
  it("lists every runtime", async () => {
    expect(await answerRuntimeControl({ request_id: "r1", action: "list" }, runtimes())).toEqual({
      requestId: "r1",
      runtimes: [running, failed],
    })
  })

  it("restarts the named runtime and returns it with the list", async () => {
    const control = runtimes()
    expect(
      await answerRuntimeControl(
        { request_id: "r2", action: "restart", name: " connector-runtime " },
        control
      )
    ).toEqual({ requestId: "r2", runtime: running, runtimes: [running, failed] })
    expect(control.restart).toHaveBeenCalledWith("connector-runtime")
  })

  it("answers a refusal or a failure with its code", async () => {
    const refused = runtimes(async () => {
      throw new HeadlessRuntimeControlError("runtime_not_found", "no such runtime")
    })
    expect(
      await answerRuntimeControl({ request_id: "r3", action: "restart", name: "x" }, refused)
    ).toEqual({ requestId: "r3", error: { code: "runtime_not_found", message: "no such runtime" } })

    const broken = runtimes(async () => {
      throw new Error("boom")
    })
    expect(
      (await answerRuntimeControl({ request_id: "r4", action: "restart", name: "x" }, broken))
        ?.error
    ).toEqual({ code: "runtime_control_failed", message: "boom" })
  })

  it("refuses a request it cannot act on, and ignores one with no id", async () => {
    expect(
      (await answerRuntimeControl({ request_id: "r5", action: "restart" }, runtimes()))?.error?.code
    ).toBe("invalid_argument")
    expect(
      (await answerRuntimeControl({ request_id: "r6", action: "explode" }, runtimes()))?.error?.code
    ).toBe("invalid_argument")
    expect(await answerRuntimeControl({ action: "list" }, runtimes())).toBeNull()
    expect(await answerRuntimeControl("nonsense", runtimes())).toBeNull()
  })
})

describe("installRuntimeControl", () => {
  it("answers the server's requests over the bridge until uninstalled", async () => {
    let handler: ((event: { payload: unknown }) => void) | null = null
    const unlisten = jest.fn()
    const invoke = jest.fn(async () => null)
    const bridge = {
      listen: jest.fn(async (event: string, h: (event: { payload: unknown }) => void) => {
        expect(event).toBe(RUNTIME_CONTROL_REQUEST_EVENT)
        handler = h
        return unlisten
      }),
      invoke,
    }
    const log = jest.fn()
    const uninstall = await installRuntimeControl(bridge as never, runtimes(), log)

    handler!({ payload: { request_id: "r1", action: "list" } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invoke).toHaveBeenCalledWith(RUNTIME_CONTROL_RESPONSE_COMMAND, {
      requestId: "r1",
      runtimes: [running, failed],
    })

    handler!({ payload: { action: "list" } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("without a request id"))

    uninstall()
    expect(unlisten).toHaveBeenCalled()
  })
})
