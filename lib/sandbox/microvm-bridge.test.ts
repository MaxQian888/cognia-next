/**
 * ADR-0028 / T4 — microvm-bridge unit tests.
 */

import {
  __resetMicrovmBridgeForTesting,
  getMicrovmExec,
  MicrovmAdapterError,
  setMicrovmExec,
  type MicrovmExecAdapter,
} from "./microvm-bridge"

afterEach(() => {
  __resetMicrovmBridgeForTesting()
})

describe("microvm exec registry", () => {
  it("exposes typed adapter refusals without losing the cause", () => {
    const cause = new Error("missing handle")
    const error = new MicrovmAdapterError("workspace-unavailable", "workspace missing", { cause })

    expect(error).toMatchObject({
      name: "MicrovmAdapterError",
      code: "workspace-unavailable",
      cause,
    })
  })

  it("starts with no registered impl", () => {
    expect(getMicrovmExec()).toBeNull()
  })

  it("setMicrovmExec stores and returns the impl", () => {
    const impl: MicrovmExecAdapter = {
      execute: jest.fn(async () => ({
        exit_code: 0,
        stdout: "",
        stderr: "",
        duration: 0,
        timed_out: false,
      })),
    }
    setMicrovmExec(impl)
    expect(getMicrovmExec()).toBe(impl)
  })

  it("setMicrovmExec(null) clears the impl", () => {
    setMicrovmExec({ execute: jest.fn() })
    setMicrovmExec(null)
    expect(getMicrovmExec()).toBeNull()
  })
})
