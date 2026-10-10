/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

jest.mock("@/hooks/data/use-client-live-query", () => ({ useClientLiveQuery: jest.fn() }))
jest.mock("@/lib/filespace/load", () => ({ loadConversationFileSpace: jest.fn() }))

const projectState = { projects: [{ id: "p1", roots: [] }] }
const hostState = {
  activeHostId: "h1" as string | null,
  hosts: [{ id: "h1", connectionState: "ready" }],
}
const settingsState = { settings: { sandboxTier: "os" } }
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector(projectState),
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (state: unknown) => unknown) => selector(hostState),
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(settingsState),
}))

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { loadConversationFileSpace } from "@/lib/filespace/load"

import { useConversationFileSpace } from "./use-conversation-filespace"

const liveQuery = useClientLiveQuery as jest.Mock

describe("useConversationFileSpace", () => {
  beforeEach(() => liveQuery.mockReset())

  it("loads the conversation's FileSpace in a live query", () => {
    liveQuery.mockReturnValue("loaded")
    const { result } = renderHook(() => useConversationFileSpace("s1"))
    expect(result.current).toBe("loaded")

    const [query, deps, initial] = liveQuery.mock.calls[0]!
    expect(initial).toBeNull()
    query()
    expect(loadConversationFileSpace).toHaveBeenCalledWith("s1")
    // The non-Dexie inputs re-run the query when they change.
    expect(deps).toEqual(["s1", projectState.projects, "h1", "ready", "os"])
  })

  it("loads nothing without a conversation", () => {
    renderHook(() => useConversationFileSpace(null))
    const [query] = liveQuery.mock.calls[0]!
    expect(query()).toBeNull()
  })
})
