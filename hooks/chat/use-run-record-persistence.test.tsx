/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { act, renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"

import { useRunRecordPersistence } from "./use-run-record-persistence"
import { useChatStore, makeSessionSlice, type SessionChatSlice } from "@/stores/chat"
import { getDb } from "@/lib/db/schema"
import { listRunRecords } from "@/lib/db/run-records"

const SID = "s1"

function seed(slice: Partial<SessionChatSlice>) {
  act(() => {
    useChatStore.setState({
      activeSessionId: SID,
      sessions: { [SID]: { ...makeSessionSlice(), ...slice } },
    })
  })
}

function assistantWithTool(state: string): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [{ type: "tool-Bash", state, input: { command: "ls" }, toolCallId: "t1" }],
  } as unknown as UIMessage
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  await getDb().runRecords.clear()
  useChatStore.setState({ activeSessionId: null, sessions: {} })
})

describe("useRunRecordPersistence", () => {
  it("is a no-op for a null session id", async () => {
    renderHook(() => useRunRecordPersistence(null))
    await act(async () => {
      await wait(50)
    })
    expect(await getDb().runRecords.count()).toBe(0)
  })

  it("does not persist a run with no work", async () => {
    seed({ status: "streaming", runId: 1, messages: [] })
    renderHook(() => useRunRecordPersistence(SID))
    await act(async () => {
      await wait(500)
    })
    expect(await listRunRecords(SID)).toHaveLength(0)
  })

  it("does not persist a fresh-slice run still at runId 0", async () => {
    seed({ status: "streaming", runId: 0, messages: [assistantWithTool("input-available")] })
    renderHook(() => useRunRecordPersistence(SID))
    await act(async () => {
      await wait(500)
    })
    expect(await listRunRecords(SID)).toHaveLength(0)
  })

  it("reschedules the debounce when work changes again before it fires", async () => {
    const { rerender } = renderHook(() => useRunRecordPersistence(SID))
    seed({ status: "streaming", runId: 1, messages: [assistantWithTool("input-available")] })
    rerender()
    // Second work update before the 400ms debounce elapses → clears + reschedules.
    seed({ status: "streaming", runId: 1, messages: [assistantWithTool("output-available")] })
    await act(async () => {
      rerender()
      await wait(500)
    })
    const rows = await listRunRecords(SID)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tools[0]!.status).toBe("output-available")
  })

  it("persists a debounced snapshot while streaming with work", async () => {
    seed({ status: "streaming", runId: 1, messages: [assistantWithTool("input-available")] })
    renderHook(() => useRunRecordPersistence(SID))
    await act(async () => {
      await wait(500)
    })
    const rows = await listRunRecords(SID)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.runId).toBe(1)
    expect(rows[0]!.status).toBe("running")
    expect(rows[0]!.settledAt).toBeUndefined()
  })

  it("never re-renders its host on streaming store commits (transient subscription)", async () => {
    let renders = 0
    renderHook(() => {
      renders += 1
      useRunRecordPersistence(SID)
    })
    const rendersAfterMount = renders
    // Simulate rAF-coalesced streaming commits: several message-array swaps.
    seed({ status: "streaming", runId: 1, messages: [assistantWithTool("input-available")] })
    seed({ status: "streaming", runId: 1, messages: [assistantWithTool("input-available")] })
    seed({ status: "streaming", runId: 1, messages: [assistantWithTool("output-available")] })
    expect(renders).toBe(rendersAfterMount)
    // The record still persists via the debounced write.
    await act(async () => {
      await wait(500)
    })
    const rows = await listRunRecords(SID)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tools[0]!.status).toBe("output-available")
  })

  it("flushes immediately and stamps settledAt on settle", async () => {
    const { rerender } = renderHook(({ id }) => useRunRecordPersistence(id), {
      initialProps: { id: SID },
    })
    seed({ status: "streaming", runId: 1, messages: [assistantWithTool("input-available")] })
    rerender({ id: SID })
    // Settle the turn before the debounce fires — the settle path writes at once.
    seed({ status: "idle", runId: 1, messages: [assistantWithTool("output-available")] })
    await act(async () => {
      rerender({ id: SID })
      await wait(50)
    })
    const rows = await listRunRecords(SID)
    expect(rows[0]!.status).toBe("done")
    expect(typeof rows[0]!.settledAt).toBe("number")
  })
})
