/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

let unread = {
  dm: 1,
  teams: new Map([
    ["a", 2],
    ["b", 5],
  ]) as ReadonlyMap<string, number>,
  total: 8,
}
jest.mock("@/hooks/shell/use-guild-unread", () => ({
  useGuildUnread: () => unread,
}))

import { setTeamMuted, useMutedTeamIds, useTeamMute, useVisibleGuildUnread } from "./use-team-mute"
import { __resetTeamOrderQueueForTests } from "./use-ordered-teams"
import { useSettingsStore } from "@/stores/settings/settings-store"

const saveMock = jest.fn(async (_patch?: Record<string, unknown>) => {})

function setSidebar(conversationSidebar: Record<string, unknown> | undefined) {
  useSettingsStore.setState({
    settings: { conversationSidebar } as never,
    save: saveMock as never,
  })
}

beforeEach(() => {
  __resetTeamOrderQueueForTests()
  saveMock.mockReset().mockResolvedValue(undefined)
  unread = {
    dm: 1,
    teams: new Map([
      ["a", 2],
      ["b", 5],
    ]),
    total: 8,
  }
  setSidebar(undefined)
})

describe("useMutedTeamIds", () => {
  it("is empty until something is muted, then follows the stored list", () => {
    const { result } = renderHook(() => useMutedTeamIds())
    expect(result.current.size).toBe(0)
    act(() => setSidebar({ mutedTeamIds: ["b"] }))
    expect([...result.current]).toEqual(["b"])
  })

  it("keeps the same set across unrelated settings writes", () => {
    setSidebar({ mutedTeamIds: ["b"] })
    const { result } = renderHook(() => useMutedTeamIds())
    const first = result.current
    act(() => setSidebar({ mutedTeamIds: ["b"], showPreview: true }))
    expect(result.current).toBe(first)
  })
})

describe("setTeamMuted", () => {
  it("merges into the stored sidebar settings rather than replacing them", async () => {
    setSidebar({ showPreview: true, teamOrder: ["b", "a"] })
    await act(async () => {
      await setTeamMuted("a", true)
    })
    expect(saveMock).toHaveBeenLastCalledWith({
      conversationSidebar: { showPreview: true, teamOrder: ["b", "a"], mutedTeamIds: ["a"] },
    })
  })

  it("unmutes cleanly", async () => {
    setSidebar({ mutedTeamIds: ["a", "b"] })
    await act(async () => {
      await setTeamMuted("a", false)
    })
    expect(saveMock).toHaveBeenLastCalledWith({ conversationSidebar: { mutedTeamIds: ["b"] } })
  })
})

describe("useTeamMute", () => {
  it("answers per team", () => {
    setSidebar({ mutedTeamIds: ["a"] })
    const { result } = renderHook(() => useTeamMute())
    expect(result.current.isMuted("a")).toBe(true)
    expect(result.current.isMuted("b")).toBe(false)
  })
})

describe("useVisibleGuildUnread", () => {
  it("leaves muted teams out of the per-team counts and the total", () => {
    setSidebar({ mutedTeamIds: ["b"] })
    const { result } = renderHook(() => useVisibleGuildUnread())
    expect(result.current.dm).toBe(1)
    expect(result.current.teams.get("b")).toBeUndefined()
    expect(result.current.total).toBe(3)
  })

  it("passes the aggregate through untouched when nothing is muted", () => {
    const { result } = renderHook(() => useVisibleGuildUnread())
    expect(result.current).toBe(unread)
  })
})
