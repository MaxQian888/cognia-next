import {
  BackpressureError,
  CogniaError,
  ConnectionLostError,
  HostNotFoundError,
  IncompatibleHostError,
  IndeterminateCommandError,
  ProtocolLimitError,
  ReconnectFailedError,
  RpcError,
  stringCodeForRpcCode,
} from "./errors"
import { RPC_ERROR_CODES } from "./rpc/protocol"

describe("error taxonomy", () => {
  it("maps every numeric wire code to a distinct stable string code", () => {
    const numbers = Object.values(RPC_ERROR_CODES)
    const codes = numbers.map(stringCodeForRpcCode)
    expect(new Set(codes).size).toBe(numbers.length)
    expect(codes).not.toContain(undefined)
  })

  it("degrades an unrecognised numeric code to internal_error", () => {
    expect(stringCodeForRpcCode(-40404)).toBe("internal_error")
  })

  it("keeps the numeric code reachable as rpcCode while code is the string", () => {
    const error = new RpcError(RPC_ERROR_CODES.sessionBusy, "busy", { sessionId: "s1" })
    expect(error.code).toBe("session_busy")
    expect(error.rpcCode).toBe(RPC_ERROR_CODES.sessionBusy)
    expect(error.data).toEqual({ sessionId: "s1" })
    expect(error).toBeInstanceOf(CogniaError)
  })

  it("gives every SDK error a stable string code and a real name", () => {
    const errors: CogniaError[] = [
      new RpcError(RPC_ERROR_CODES.timeout, "slow"),
      new HostNotFoundError(["/usr/bin"]),
      new IncompatibleHostError(3, [2]),
      new BackpressureError({ lastEventId: "e9", capacity: 8, droppedCount: 1 }),
      new IndeterminateCommandError({ commandId: "c1", method: "turn/run" }),
      new ConnectionLostError(),
      new ReconnectFailedError(5),
      new ProtocolLimitError("maxOpenSessions", 32, 33),
    ]
    for (const error of errors) {
      expect(typeof error.code).toBe("string")
      expect(error.code.length).toBeGreaterThan(0)
      expect(error.name).toBe(error.constructor.name)
      expect(error.message.length).toBeGreaterThan(0)
    }
  })

  it("carries the resume cursor and the capacity that was exceeded", () => {
    const error = new BackpressureError({ lastEventId: "e9", capacity: 1024, droppedCount: 3 })
    expect(error.lastEventId).toBe("e9")
    expect(error.capacity).toBe(1024)
    expect(error.droppedCount).toBe(3)
  })

  it("omits lastEventId entirely when nothing was delivered", () => {
    const error = new BackpressureError({ capacity: 4, droppedCount: 1 })
    expect("lastEventId" in error).toBe(false)
    expect(error.message).toContain("the beginning")
  })

  it("names the command whose outcome is unknown and never implies a retry happened", () => {
    const error = new IndeterminateCommandError({
      commandId: "cmd-7",
      method: "turn/run",
      sessionId: "s1",
      cause: new Error("socket closed"),
    })
    expect(error.commandId).toBe("cmd-7")
    expect(error.method).toBe("turn/run")
    expect(error.sessionId).toBe("s1")
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.message).toContain("same commandId")
  })

  it("reports which protocol limit was hit and by how much", () => {
    const error = new ProtocolLimitError("maxActiveTurns", 8, 9)
    expect(error.limit).toBe("maxActiveTurns")
    expect(error.allowed).toBe(8)
    expect(error.requested).toBe(9)
    expect(error.code).toBe("limit_exceeded")
  })

  it("lists every protocol version the SDK supports on an incompatible host", () => {
    const error = new IncompatibleHostError(9, [2, 3])
    expect(error.hostProtocolVersion).toBe(9)
    expect(error.supportedProtocolVersions).toEqual([2, 3])
    expect(error.message).toContain("v2, v3")
  })
})
