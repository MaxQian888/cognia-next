import { moveTeamInOrder, orderTeams, teamOrderFrom } from "./team-order"

const teams = [{ id: "a" }, { id: "b" }, { id: "c" }]

describe("orderTeams", () => {
  it("returns the teams unchanged when no order is stored", () => {
    expect(orderTeams(teams, undefined)).toEqual(teams)
    expect(orderTeams(teams, [])).toEqual(teams)
  })

  it("does not hand back the caller's array", () => {
    const result = orderTeams(teams, undefined)
    expect(result).not.toBe(teams)
  })

  it("puts listed teams first, in the stored order", () => {
    expect(orderTeams(teams, ["c", "a", "b"]).map((t) => t.id)).toEqual(["c", "a", "b"])
  })

  it("appends teams the order never mentioned, keeping their incoming order", () => {
    expect(orderTeams(teams, ["c"]).map((t) => t.id)).toEqual(["c", "a", "b"])
  })

  it("skips ids whose team no longer exists", () => {
    expect(orderTeams(teams, ["gone", "b", "also-gone", "a"]).map((t) => t.id)).toEqual([
      "b",
      "a",
      "c",
    ])
  })

  it("renders a duplicated id once", () => {
    expect(orderTeams(teams, ["b", "b", "a"]).map((t) => t.id)).toEqual(["b", "a", "c"])
  })
})

describe("teamOrderFrom", () => {
  it("captures the rendered order as ids", () => {
    expect(teamOrderFrom(teams)).toEqual(["a", "b", "c"])
  })
})

describe("moveTeamInOrder", () => {
  it("moves a team up", () => {
    expect(moveTeamInOrder(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"])
  })

  it("moves a team down", () => {
    expect(moveTeamInOrder(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"])
  })

  it("refuses a move past either end", () => {
    expect(moveTeamInOrder(["a", "b"], "a", -1)).toBeNull()
    expect(moveTeamInOrder(["a", "b"], "b", 1)).toBeNull()
  })

  it("refuses an id it does not know", () => {
    expect(moveTeamInOrder(["a", "b"], "z", 1)).toBeNull()
  })

  it("does not mutate the input", () => {
    const ids = ["a", "b", "c"]
    moveTeamInOrder(ids, "a", 2)
    expect(ids).toEqual(["a", "b", "c"])
  })
})
