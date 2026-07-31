/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { useTeamMembers } from "./use-team-members"
import type { Character, Team } from "@cognia/agent-config-types"

const liveQueryMock = jest.fn<unknown, [() => Promise<unknown>, unknown[], unknown]>()

jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T>(fn: () => Promise<T>, deps: unknown[], fallback: T) =>
    liveQueryMock(fn as never, deps, fallback),
}))

jest.mock("@/lib/db/teams", () => ({
  getTeam: jest.fn(),
}))

jest.mock("@/lib/db/characters", () => ({
  listCharactersByIds: jest.fn(),
}))

beforeEach(() => {
  liveQueryMock.mockReset()
})

test("returns empty array when teamId is null", () => {
  liveQueryMock.mockReturnValue(undefined)
  const { result } = renderHook(() => useTeamMembers(null))
  expect(result.current).toEqual([])
})

test("returns empty array when team has not loaded yet", () => {
  liveQueryMock.mockReturnValue(undefined)
  const { result } = renderHook(() => useTeamMembers("team-1"))
  expect(result.current).toEqual([])
})

test("returns characters in team-defined order, skipping missing ids", () => {
  const team: Team = {
    id: "t1",
    name: "T",
    members: [{ characterId: "c1" }, { characterId: "missing" }, { characterId: "c2" }],
  } as unknown as Team
  const c1: Character = { id: "c1", name: "Alice" } as unknown as Character
  const c2: Character = { id: "c2", name: "Bob" } as unknown as Character

  let call = 0
  liveQueryMock.mockImplementation(() => {
    call += 1
    if (call === 1) return team
    return [c1, c2]
  })

  const { result } = renderHook(() => useTeamMembers("t1"))
  expect(result.current).toEqual([c1, c2])
})

test("returns empty when characters list is empty", () => {
  const team: Team = {
    id: "t2",
    name: "Empty",
    members: [{ characterId: "c1" }],
  } as unknown as Team
  let call = 0
  liveQueryMock.mockImplementation(() => {
    call += 1
    if (call === 1) return team
    return []
  })
  const { result } = renderHook(() => useTeamMembers("t2"))
  expect(result.current).toEqual([])
})
