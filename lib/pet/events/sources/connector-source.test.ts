import type { PetEvent } from "@/types/pet"

let captured: ((event: unknown) => void) | null = null
const disposer = jest.fn()

jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({
    subscribeInbound: (obs: (event: unknown) => void) => {
      captured = obs
      return disposer
    },
  }),
}))

import { wireConnectorSource } from "./connector-source"

beforeEach(() => {
  captured = null
  disposer.mockClear()
})

describe("wireConnectorSource", () => {
  it("emits inboundMessage on each inbound event and returns the disposer", () => {
    const events: PetEvent[] = []
    const off = wireConnectorSource((e) => events.push({ ...e, at: 0 }))
    expect(captured).not.toBeNull()
    captured?.({ adapterId: "x" })
    captured?.({ adapterId: "y" })
    expect(events.map((e) => e.kind)).toEqual(["inboundMessage", "inboundMessage"])
    expect(events[0]).toMatchObject({ source: "connector", xp: 1 })
    off()
    expect(disposer).toHaveBeenCalled()
  })
})
