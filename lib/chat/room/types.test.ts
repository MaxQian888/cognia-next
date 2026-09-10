import type { RoomKind, RoomReplyMode, RoomRosterCompleteness, RoomSettings } from "./types"

describe("room vocabulary", () => {
  it("names exactly the three memberships and the three reply modes", () => {
    const kinds: Record<RoomKind, true> = { team: true, shared: true, im: true }
    const modes: Record<RoomReplyMode, true> = { auto: true, mention_only: true, asleep: true }
    const completeness: Record<RoomRosterCompleteness, true> = {
      full: true,
      partial: true,
      observed: true,
    }
    expect(Object.keys(kinds)).toHaveLength(3)
    expect(Object.keys(modes)).toHaveLength(3)
    expect(Object.keys(completeness)).toHaveLength(3)
  })

  it("keeps every room setting optional so an absent object means inherit", () => {
    const empty: RoomSettings = {}
    expect(empty).toEqual({})
  })
})
