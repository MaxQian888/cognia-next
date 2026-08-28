import {
  THREAD_HANDOFF_COMMANDS,
  dispatchThreadHandoffCommand,
  isThreadHandoffCommand,
} from "./host-dispatch"

jest.mock("@/lib/db/thread-handoff-tickets", () => ({
  getThreadHandoffTicket: jest.fn(async () => ({ ticketId: "ticket-1", state: "frozen" })),
}))

describe("thread handoff host dispatch", () => {
  it("keeps the six-command family closed", () => {
    expect(THREAD_HANDOFF_COMMANDS).toHaveLength(6)
    for (const command of THREAD_HANDOFF_COMMANDS)
      expect(isThreadHandoffCommand(command)).toBe(true)
    expect(isThreadHandoffCommand("thread_handoff_delete")).toBe(false)
  })

  it("returns the persisted role-specific status", async () => {
    await expect(
      dispatchThreadHandoffCommand(
        "thread_handoff_status",
        { ticketId: "ticket-1", role: "source" },
        { importSession: jest.fn() }
      )
    ).resolves.toEqual({ ticketId: "ticket-1", state: "frozen" })
  })
})
