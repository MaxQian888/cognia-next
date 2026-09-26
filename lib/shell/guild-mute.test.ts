import { applyGuildMute, mutedTeamSet, withTeamMuted } from "./guild-mute"

const unread = () => ({
  dm: 2,
  teams: new Map([
    ["a", 3],
    ["b", 1],
  ]) as ReadonlyMap<string, number>,
  total: 6,
})

describe("mutedTeamSet", () => {
  it("reads absent or empty as nothing muted", () => {
    expect(mutedTeamSet(undefined).size).toBe(0)
    expect(mutedTeamSet([]).size).toBe(0)
    expect([...mutedTeamSet(["a", "a", "b"])]).toEqual(["a", "b"])
  })
})

describe("applyGuildMute", () => {
  it("returns the aggregate untouched when nothing is muted", () => {
    const input = unread()
    expect(applyGuildMute(input, new Set())).toBe(input)
    expect(applyGuildMute(input, new Set(["gone"]))).toBe(input)
  })

  it("drops muted teams from the per-team map and the total", () => {
    const result = applyGuildMute(unread(), new Set(["a"]))
    expect(result.dm).toBe(2)
    expect([...result.teams]).toEqual([["b", 1]])
    expect(result.total).toBe(3)
  })

  it("never mutes Chats — only teams can be muted", () => {
    expect(applyGuildMute(unread(), new Set(["a", "b"])).total).toBe(2)
  })
})

describe("withTeamMuted", () => {
  it("adds once and removes cleanly", () => {
    expect(withTeamMuted(undefined, "a", true)).toEqual(["a"])
    expect(withTeamMuted(["a"], "a", true)).toEqual(["a"])
    expect(withTeamMuted(["a", "b"], "a", false)).toEqual(["b"])
    expect(withTeamMuted(undefined, "a", false)).toEqual([])
  })
})
