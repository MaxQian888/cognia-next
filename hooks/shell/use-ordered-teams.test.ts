/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { __resetTeamOrderQueueForTests, useOrderedTeams } from "./use-ordered-teams"
import { useSettingsStore } from "@/stores/settings/settings-store"

const listed: { id: string; name: string }[] = []

jest.mock("@/lib/db/teams", () => ({ listTeams: jest.fn(async () => listed) }))
// The live query is the only Dexie touch in this hook; stubbing it keeps the
// suite on the settings store, which is what the hook actually decides with.
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: jest.fn(() => listed),
}))

const saveMock = jest.fn(async (_patch?: Record<string, unknown>) => {})

function setTeams(ids: string[]) {
  listed.length = 0
  listed.push(...ids.map((id) => ({ id, name: id })))
}

function lastOrder(): string[] | undefined {
  const patch = saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as
    { conversationSidebar?: { teamOrder?: string[] } } | undefined
  return patch?.conversationSidebar?.teamOrder
}

beforeEach(() => {
  __resetTeamOrderQueueForTests()
  saveMock.mockReset().mockResolvedValue(undefined)
  setTeams(["a", "b", "c"])
  useSettingsStore.setState({ settings: {} as never, save: saveMock as never })
})

describe("useOrderedTeams", () => {
  it("keeps the Dexie order when nothing was ever dragged", () => {
    const { result } = renderHook(() => useOrderedTeams())
    expect(result.current.teamIds).toEqual(["a", "b", "c"])
  })

  it("applies the stored order and appends unlisted teams", () => {
    useSettingsStore.setState({
      settings: { conversationSidebar: { teamOrder: ["c"] } } as never,
      save: saveMock as never,
    })
    const { result } = renderHook(() => useOrderedTeams())
    expect(result.current.teamIds).toEqual(["c", "a", "b"])
  })

  it("writes the whole order, merged into the existing sidebar settings", async () => {
    useSettingsStore.setState({
      settings: { conversationSidebar: { showPreview: true } } as never,
      save: saveMock as never,
    })
    const { result } = renderHook(() => useOrderedTeams())
    await act(async () => {
      result.current.reorderTeams(["b", "a", "c"])
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock.mock.calls[0]?.[0]).toEqual({
      conversationSidebar: { showPreview: true, teamOrder: ["b", "a", "c"] },
    })
  })

  it("moves one team by a slot", async () => {
    const { result } = renderHook(() => useOrderedTeams())
    await act(async () => {
      result.current.moveTeam("c", -1)
    })
    expect(lastOrder()).toEqual(["a", "c", "b"])
  })

  it("does not write when the move has nowhere to go", async () => {
    const { result } = renderHook(() => useOrderedTeams())
    await act(async () => {
      result.current.moveTeam("a", -1)
    })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("derives a queued write from the settings the previous write left behind", async () => {
    let resolveFirst: (() => void) | undefined
    saveMock.mockImplementationOnce(async (patch) => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      useSettingsStore.setState({ settings: patch as never })
    })
    const { result } = renderHook(() => useOrderedTeams())
    await act(async () => {
      result.current.reorderTeams(["b", "a", "c"])
      result.current.reorderTeams(["c", "b", "a"])
      resolveFirst?.()
    })
    expect(saveMock).toHaveBeenCalledTimes(2)
    // The second write merged onto the first write's result, not onto the
    // snapshot both callers rendered with.
    expect(saveMock.mock.calls[1]?.[0]).toEqual({
      conversationSidebar: { teamOrder: ["c", "b", "a"] },
    })
  })
})
