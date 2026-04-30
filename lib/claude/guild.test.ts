import { guildFromSession } from "./guild"

test("returns DM guild for null/undefined session", () => {
  expect(guildFromSession(null)).toEqual({ kind: "dm" })
  expect(guildFromSession(undefined)).toEqual({ kind: "dm" })
})

test("returns DM guild for direct sessions", () => {
  expect(guildFromSession({ kind: "direct" })).toEqual({ kind: "dm" })
})

test("returns DM guild for team sessions missing teamId", () => {
  expect(guildFromSession({ kind: "team" })).toEqual({ kind: "dm" })
  expect(guildFromSession({ kind: "team", teamId: null })).toEqual({ kind: "dm" })
})

test("returns team guild for team sessions with teamId", () => {
  expect(guildFromSession({ kind: "team", teamId: "t-1" })).toEqual({
    kind: "team",
    teamId: "t-1",
  })
})
