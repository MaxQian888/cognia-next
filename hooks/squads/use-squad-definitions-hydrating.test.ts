/** @jest-environment jsdom */

// Cold-load detection for Squad definitions: Dexie's count against the store,
// with the bridge's own verdict as the backstop.

import { act, renderHook } from "@testing-library/react"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

let mockCount: number | undefined = undefined
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => mockCount }))

let settle!: () => void
let fail!: (error: unknown) => void
jest.mock("@/stores/agent/agent-team-store/dexie-bridge", () => ({
  whenAgentTeamDexieBridgeHydrated: () =>
    new Promise<void>((resolve, reject) => {
      settle = resolve
      fail = reject
    }),
}))

import { useSquadDefinitionsHydrating } from "./use-squad-definitions-hydrating"

beforeEach(() => {
  mockCount = undefined
  useAgentTeamStore.setState({ teams: {} as never })
})

it("is hydrating until Dexie answers", () => {
  expect(renderHook(() => useSquadDefinitionsHydrating()).result.current).toBe(true)
})

it("is done when Dexie holds no Squads", () => {
  mockCount = 0
  expect(renderHook(() => useSquadDefinitionsHydrating()).result.current).toBe(false)
})

/** The cold-load window that made Settings flash the gallery. */
it("is hydrating while Dexie holds Squads the store does not yet", () => {
  mockCount = 2
  expect(renderHook(() => useSquadDefinitionsHydrating()).result.current).toBe(true)
})

it("is done once the store holds them", () => {
  mockCount = 2
  useAgentTeamStore.setState({ teams: { a: { id: "a" } } as never })
  expect(renderHook(() => useSquadDefinitionsHydrating()).result.current).toBe(false)
})

/** A failed hydration leaves the store empty; the skeleton must not stay for good. */
it("stops waiting when the bridge settles, even with the store still empty", async () => {
  mockCount = 2
  const { result } = renderHook(() => useSquadDefinitionsHydrating())
  expect(result.current).toBe(true)
  await act(async () => settle())
  expect(result.current).toBe(false)
})

it("stops waiting when the bridge's hydration rejects", async () => {
  mockCount = 2
  const { result } = renderHook(() => useSquadDefinitionsHydrating())
  await act(async () => fail(new Error("mirror disabled")))
  expect(result.current).toBe(false)
})
