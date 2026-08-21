/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"

import { useChatExecutor } from "./use-chat-executor"
import { getDb } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

async function seedSession(id: string, extra: Record<string, unknown> = {}) {
  await getDb().sessions.put({
    id,
    title: "T",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as never)
}

function seedSquads(squads: Array<{ id: string; name: string }>) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(
      squads.map((s) => [s.id, { id: s.id, name: s.name } as never])
    ) as never,
  })
}

beforeEach(async () => {
  await getDb().sessions.clear()
  seedSquads([])
}, 30_000)

describe("useChatExecutor", () => {
  it("reports no Squad for an unbound conversation", async () => {
    await seedSession("s1")
    const { result } = renderHook(() => useChatExecutor("s1"))
    await waitFor(() => expect(result.current.bindable).toBe(true))
    expect(result.current.squadId).toBeNull()
    expect(result.current.squadName).toBeNull()
  })

  it("names the bound Squad", async () => {
    seedSquads([{ id: "sq-1", name: "Research" }])
    await seedSession("s1", { squadId: "sq-1" })
    const { result } = renderHook(() => useChatExecutor("s1"))
    await waitFor(() => expect(result.current.squadId).toBe("sq-1"))
    expect(result.current.squadName).toBe("Research")
  })

  it("shows no name when the binding points at a deleted Squad", async () => {
    // A raw id on the chip would read as a working selection.
    await seedSession("s1", { squadId: "gone" })
    const { result } = renderHook(() => useChatExecutor("s1"))
    await waitFor(() => expect(result.current.squadId).toBe("gone"))
    expect(result.current.squadName).toBeNull()
  })

  it("offers every Squad, name-sorted", async () => {
    seedSquads([
      { id: "b", name: "Bravo" },
      { id: "a", name: "Alpha" },
      { id: "c", name: "Charlie" },
    ])
    await seedSession("s1")
    const { result } = renderHook(() => useChatExecutor("s1"))
    await waitFor(() => expect(result.current.squads).toHaveLength(3))
    expect(result.current.squads.map((s) => s.name)).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  it("binds the conversation to a Squad", async () => {
    seedSquads([{ id: "sq-1", name: "Research" }])
    await seedSession("s1")
    const { result } = renderHook(() => useChatExecutor("s1"))
    await waitFor(() => expect(result.current.bindable).toBe(true))
    await act(async () => {
      await result.current.select("sq-1")
    })
    expect((await getSession("s1"))?.squadId).toBe("sq-1")
  })

  it("actually CLEARS the column when going back to a single agent", async () => {
    // Dexie's `update` deletes a key set to undefined. If that ever stopped
    // being true, unbinding would silently keep running the Squad.
    seedSquads([{ id: "sq-1", name: "Research" }])
    await seedSession("s1", { squadId: "sq-1" })
    const { result } = renderHook(() => useChatExecutor("s1"))
    await waitFor(() => expect(result.current.squadId).toBe("sq-1"))
    await act(async () => {
      await result.current.select(null)
    })
    const row = await getSession("s1")
    expect(row?.squadId).toBeUndefined()
    expect(Object.hasOwn(row ?? {}, "squadId")).toBe(false)
  })

  it("is not bindable before the conversation exists", async () => {
    const { result } = renderHook(() => useChatExecutor(undefined))
    await waitFor(() => expect(result.current.bindable).toBe(false))
    // Selecting is a no-op rather than a throw — the composer renders before
    // the first turn has created a session.
    await act(async () => {
      await result.current.select("sq-1")
    })
    expect(result.current.squadId).toBeNull()
  })
})
