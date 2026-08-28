import { assertSessionWritable, SessionHandoffLockedError } from "./session-write-guard"

describe("assertSessionWritable", () => {
  it("allows an ordinary session", () => {
    expect(() => assertSessionWritable({ id: "session-1" }, "send-message")).not.toThrow()
  })

  it("rejects every mutation kind while a handoff lock exists", () => {
    const session = {
      id: "session-1",
      handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
    } as const

    for (const operation of [
      "send-message",
      "continue-run",
      "title",
      "metadata",
      "workspace-move",
      "branch",
      "delete",
    ] as const) {
      expect(() => assertSessionWritable(session, operation)).toThrow(SessionHandoffLockedError)
    }
  })
})
