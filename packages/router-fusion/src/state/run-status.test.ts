import transitions from "../contracts/spec/state_transitions.json"
import { RUN_STATUSES, type RunStatus } from "../contracts/schemas"
import {
  IllegalRunTransitionError,
  TERMINAL_RUN_STATUSES,
  acceptsNewCalls,
  allowedRunTransitions,
  assertRunTransition,
  canTransitionRun,
  isTerminalRunStatus,
  projectHostRunStatus,
  specRunStatusFromHost,
} from "./run-status"

describe("run status machine", () => {
  it("covers exactly the contract statuses", () => {
    expect(Object.keys(transitions).sort()).toEqual([...RUN_STATUSES].sort())
  })

  it("follows state_transitions.json edge for edge", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        const expected = (transitions as Record<string, string[]>)[from].includes(to)
        expect(canTransitionRun(from, to)).toBe(expected)
      }
      expect(allowedRunTransitions(from)).toEqual((transitions as Record<string, string[]>)[from])
    }
  })

  it("treats succeeded/failed/cancelled/expired as terminal with no way back", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual([
      "cancelled",
      "expired",
      "failed",
      "succeeded",
    ])
    for (const terminal of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(terminal)).toBe(true)
      expect(() => assertRunTransition(terminal, "running")).toThrow(IllegalRunTransitionError)
    }
  })

  it("only lets cancelling end as cancelled", () => {
    expect(allowedRunTransitions("cancelling")).toEqual(["cancelled"])
    expect(canTransitionRun("cancelling", "succeeded")).toBe(false)
  })

  it("admits new business calls only while running", () => {
    for (const status of RUN_STATUSES) {
      expect(acceptsNewCalls(status)).toBe(status === "running")
    }
  })

  it("round-trips every spec status through the host projection", () => {
    for (const status of RUN_STATUSES) {
      expect(specRunStatusFromHost(projectHostRunStatus(status))).toBe(status)
    }
  })

  it("keeps the host coarse status for waiting and expired runs", () => {
    expect(projectHostRunStatus("waiting_for_approval")).toEqual({
      status: "waiting",
      statusDetail: "waiting_for_approval",
    })
    expect(projectHostRunStatus("expired")).toEqual({ status: "failed", statusDetail: "expired" })
    expect(projectHostRunStatus("succeeded")).toEqual({ status: "completed" })
  })

  it("maps recovery_required to reconciling and rejects inconsistent projections", () => {
    expect(specRunStatusFromHost({ status: "recovery_required" })).toBe("reconciling")
    expect(() => specRunStatusFromHost({ status: "waiting" })).toThrow()
    expect(() => specRunStatusFromHost({ status: "completed", statusDetail: "expired" })).toThrow()
    expect(() =>
      specRunStatusFromHost({ status: "queued", statusDetail: "cancelling" as never })
    ).toThrow()
  })

  it("names the rejected edge", () => {
    try {
      assertRunTransition("queued", "succeeded" as RunStatus)
      throw new Error("expected throw")
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalRunTransitionError)
      expect((error as IllegalRunTransitionError).from).toBe("queued")
      expect((error as IllegalRunTransitionError).code).toBe("ILLEGAL_RUN_TRANSITION")
    }
  })
})
