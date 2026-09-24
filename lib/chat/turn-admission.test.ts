import type { UIMessage } from "ai"
import {
  markTurnAdmission,
  resolveTurnAdmissionDisplay,
  turnAdmissionMetaOf,
  turnMessageId,
  waitFromBlocker,
  withTurnAdmission,
  type TurnAdmissionMeta,
} from "./turn-admission"

const user = (id: string, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: id }], metadata }) as UIMessage
const assistant = (id: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text: id }] }) as UIMessage

const queued: TurnAdmissionMeta = {
  state: "queued",
  waitingFor: { reason: "slot", holderKind: "workflow-step", holderLabel: "Ship it" },
  since: 1,
}
const failed: TurnAdmissionMeta = {
  state: "failed",
  code: "initializationFailed",
  detail: "Pi process exited (code 1) before the Cognia extension was ready",
  at: 2,
}

describe("turnAdmissionMetaOf", () => {
  it("reads both states and rejects malformed rows", () => {
    expect(turnAdmissionMetaOf({ turnAdmission: queued })).toEqual(queued)
    expect(turnAdmissionMetaOf({ turnAdmission: failed })).toEqual(failed)
    expect(turnAdmissionMetaOf({ turnAdmission: { state: "queued" } })).toBeNull()
    expect(turnAdmissionMetaOf({ turnAdmission: { state: "failed" } })).toBeNull()
    expect(turnAdmissionMetaOf({ turnAdmission: "queued" })).toBeNull()
    expect(turnAdmissionMetaOf(undefined)).toBeNull()
  })
})

describe("waitFromBlocker", () => {
  it("names the work holding the tree", () => {
    expect(
      waitFromBlocker({
        reason: "slot",
        slotKey: "dir:/repo",
        ahead: 0,
        holder: {
          id: "leg1",
          kind: "workflow-step",
          resource: "ai-turn",
          label: "Ship it",
          weight: 1,
          exempt: false,
          state: "running",
          startedAt: 0,
          cancelled: false,
        },
      })
    ).toEqual({ reason: "slot", holderKind: "workflow-step", holderLabel: "Ship it" })
  })

  it("keeps only the reason for a shared ceiling", () => {
    expect(waitFromBlocker({ reason: "capacity", limit: 3, ahead: 2 })).toEqual({
      reason: "capacity",
    })
  })
})

describe("marking a turn", () => {
  it("sets and clears the mark without touching other metadata", () => {
    const message = user("u1", { mentions: ["x"] })
    const marked = withTurnAdmission(message, failed)
    expect(marked.metadata).toEqual({ mentions: ["x"], turnAdmission: failed })
    expect(withTurnAdmission(marked, null).metadata).toEqual({ mentions: ["x"] })
    // Nothing to clear: the same object back, so callers can skip a write.
    expect(withTurnAdmission(message, null)).toBe(message)
  })

  it("marks only the named message and reports no-ops by identity", () => {
    const list = [user("u1"), assistant("a1"), user("u2")]
    const next = markTurnAdmission(list, "u2", queued)
    expect(turnAdmissionMetaOf(next[2].metadata)).toEqual(queued)
    expect(next[0]).toBe(list[0])
    expect(markTurnAdmission(list, "u1", null)).toBe(list)
    expect(markTurnAdmission(list, null, queued)).toBe(list)
  })

  it("falls back to the last user message for a re-issued turn", () => {
    const list = [user("u1"), assistant("a1"), user("u2"), assistant("a2")]
    expect(turnMessageId(list, "u1")).toBe("u1")
    expect(turnMessageId(list, "missing")).toBe("u2")
    expect(turnMessageId(list)).toBe("u2")
    expect(turnMessageId([assistant("a")])).toBeNull()
  })
})

describe("resolveTurnAdmissionDisplay", () => {
  it("shows a queued turn as queued only while its send is still waiting", () => {
    expect(resolveTurnAdmissionDisplay(queued, { stillQueued: true })).toBe("queued")
    // A reload ended the wait: the turn never ran.
    expect(resolveTurnAdmissionDisplay(queued, { stillQueued: false })).toBe("interrupted")
    expect(resolveTurnAdmissionDisplay(failed, { stillQueued: false })).toBe("failed")
  })
})
