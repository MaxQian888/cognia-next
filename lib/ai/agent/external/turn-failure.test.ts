import { classifyExternalTurnFailure, planHaltCauseForCode } from "./turn-failure"
import { LeaseConflictError } from "@/lib/execution/lease-conflict"
import {
  PiExtensionHandshakeError,
  PiProcessExitedError,
  PiResourceLimitError,
} from "./runtimes/pi/pi-rpc-client"

describe("classifyExternalTurnFailure", () => {
  it("reads a Pi startup exit as an agent that failed to start", () => {
    expect(classifyExternalTurnFailure(new PiProcessExitedError(1))).toBe("initializationFailed")
  })

  it("maps the other typed Pi failures through their lifecycle reason codes", () => {
    expect(classifyExternalTurnFailure(new PiExtensionHandshakeError("s1"))).toBe(
      "extensionHandshakeFailed"
    )
    expect(classifyExternalTurnFailure(new PiResourceLimitError(4))).toBe("resourceLimit")
  })

  it("names the resource a lease conflict collided on", () => {
    expect(
      classifyExternalTurnFailure(
        new LeaseConflictError("agent-process", "held", { holder: "pi:x" })
      )
    ).toBe("agentProcessBusy")
    expect(classifyExternalTurnFailure(new LeaseConflictError("working-copy", "held"))).toBe(
      "workspaceBusy"
    )
  })

  it("finds the typed failure inside a startup AggregateError or a cause chain", () => {
    const aggregate = new AggregateError(
      [new PiProcessExitedError(null), new Error("kill failed")],
      "Pi startup and process cleanup failed"
    )
    expect(classifyExternalTurnFailure(aggregate)).toBe("initializationFailed")
    const wrapped = new Error("session failed", {
      cause: new LeaseConflictError("agent-process", "held"),
    })
    expect(classifyExternalTurnFailure(wrapped)).toBe("agentProcessBusy")
  })

  it("defers to text classification for anything untyped", () => {
    expect(classifyExternalTurnFailure(new Error("402 Insufficient Balance"))).toBeNull()
    expect(classifyExternalTurnFailure({ reasonCode: "not-a-known-reason" })).toBeNull()
    expect(classifyExternalTurnFailure("plain string")).toBeNull()
  })
})

describe("planHaltCauseForCode", () => {
  it("separates a turn that never started from one that failed while running", () => {
    expect(planHaltCauseForCode("initializationFailed")).toBe("not_started")
    expect(planHaltCauseForCode("agentProcessBusy")).toBe("not_started")
    expect(planHaltCauseForCode("workspaceBusy")).toBe("not_started")
    expect(planHaltCauseForCode("executionFailed")).toBe("turn_failed")
    expect(planHaltCauseForCode("unknown")).toBe("turn_failed")
  })
})
