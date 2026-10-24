import {
  AUTOMATED_TURN_PRODUCERS,
  automatedTurnMetadata,
  isAutomatedTurnMetadata,
} from "./automated-turn"

describe("automated turn marker", () => {
  it("round-trips every producer", () => {
    for (const producer of AUTOMATED_TURN_PRODUCERS) {
      const metadata = automatedTurnMetadata(producer)
      expect(metadata).toEqual({ automatedTurn: { producer } })
      expect(isAutomatedTurnMetadata(metadata)).toBe(true)
    }
  })

  it("counts any marker object, including one from a newer build", () => {
    expect(isAutomatedTurnMetadata({ automatedTurn: { producer: "future-thing" } })).toBe(true)
  })

  it("does not count rows without one", () => {
    for (const metadata of [undefined, null, {}, { automatedTurn: true }, { automatedTurn: "x" }]) {
      expect(isAutomatedTurnMetadata(metadata)).toBe(false)
    }
  })
})
