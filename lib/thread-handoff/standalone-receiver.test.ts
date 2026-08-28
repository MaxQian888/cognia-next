import type { ThreadHandoffOfferFrame } from "./orchestrator"
import {
  completeInboundThreadHandoff,
  prepareInboundThreadHandoff,
  type PreparedInboundThreadHandoff,
} from "./standalone-receiver"

const frame = {
  ticket: {
    role: "target",
    target: { kind: "mobile", hostRef: "phone-1" },
  },
} as ThreadHandoffOfferFrame

describe("standalone thread handoff receiver", () => {
  it("ignores offers addressed to another device", async () => {
    await expect(
      prepareInboundThreadHandoff(frame, "phone-2", {
        environment: jest.fn() as never,
      })
    ).resolves.toBeNull()
  })

  it("never imports when preflight is blocked", async () => {
    const importSession = jest.fn()
    const prepared = {
      frame,
      ticket: frame.ticket,
      preflight: { ok: false, blockers: [], achievableFidelity: "unsupported", checkedAt: 1 },
    } as PreparedInboundThreadHandoff
    await expect(completeInboundThreadHandoff(prepared, { importSession })).rejects.toThrow(
      "thread_handoff_preflight_blocked"
    )
    expect(importSession).not.toHaveBeenCalled()
  })
})
