/** @jest-environment jsdom */

// "Not in the store yet" against "really gone", asked of Dexie by id.

import { renderHook } from "@testing-library/react"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"

let mockStored: boolean | undefined = undefined
const queries: unknown[][] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (_query: unknown, deps: unknown[]) => {
    queries.push(deps)
    return mockStored
  },
}))

import { useSelectedSquad } from "./use-selected-squad"

const squad = { id: "a", name: "Alpha" } as unknown as AgentTeam

beforeEach(() => {
  mockStored = undefined
  queries.length = 0
  useAgentTeamStore.setState({ teams: {} as never })
})

it("answers none when no Squad is named", () => {
  expect(renderHook(() => useSelectedSquad(undefined)).result.current).toEqual({ status: "none" })
})

it("finds a Squad the store holds", () => {
  useAgentTeamStore.setState({ teams: { a: squad } as never })
  expect(renderHook(() => useSelectedSquad("a")).result.current).toEqual({
    status: "found",
    squad,
  })
})

it("is loading until Dexie answers", () => {
  expect(renderHook(() => useSelectedSquad("a")).result.current).toEqual({ status: "loading" })
})

/** The store fills from Dexie after the first read; a row there is on its way. */
it("is still loading while Dexie holds a row the store does not yet", () => {
  mockStored = true
  expect(renderHook(() => useSelectedSquad("a")).result.current).toEqual({ status: "loading" })
})

it("is missing only when Dexie does not hold it either", () => {
  mockStored = false
  expect(renderHook(() => useSelectedSquad("gone")).result.current).toEqual({
    status: "missing",
  })
})

it("asks again when the store gains or loses the Squad", () => {
  renderHook(() => useSelectedSquad("a"))
  expect(queries.at(-1)).toEqual(["a", false])
})
