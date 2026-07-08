import { renderHook, act, waitFor } from "@testing-library/react"
import { useSessionImport, summaryKey } from "./use-session-import"
import type { SessionScanInput, SessionSummary } from "@/lib/session-import"

const input: SessionScanInput = {
  fs: {
    exists: async () => false,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  },
  home: "/home/u",
}

function summary(id: string): SessionSummary {
  return {
    ref: { sourceId: "codex", originalSessionId: id, locator: `/p/${id}.jsonl` },
    title: `session ${id}`,
    sourceId: "codex",
    messageCount: 3,
    updatedAt: 1,
  }
}

function deps(over: Parameters<typeof useSessionImport>[0] = {}) {
  return {
    resolveScanInput: jest.fn(async () => input),
    scanAllSources: jest.fn(async () => ({ summaries: [summary("a"), summary("b")], errors: [] })),
    listSessionsForSource: jest.fn(async () => [summary("a")]),
    importSessions: jest.fn(async () => ({ sessions: 2, messages: 6 })),
    pick: jest.fn(async () => [{ name: "a.jsonl", path: "/p/a.jsonl", content: "{}" }]),
    detect: jest.fn(() => "codex"),
    ...over,
  }
}

describe("useSessionImport", () => {
  it("scans, pre-selects all, and imports the selection", async () => {
    const d = deps()
    const { result } = renderHook(() => useSessionImport(d))

    await act(async () => {
      await result.current.scan()
    })
    expect(result.current.state.status).toBe("list")
    expect(result.current.selectedCount).toBe(2)

    await act(async () => {
      await result.current.importSelected("proj-1")
    })
    expect(d.importSessions).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ originalSessionId: "a" })]),
      input,
      "proj-1"
    )
    expect(result.current.state).toMatchObject({
      status: "done",
      sessionsAdded: 2,
      messagesAdded: 6,
    })
  })

  it("surfaces per-source scan failures as list warnings", async () => {
    const d = deps({
      scanAllSources: jest.fn(async () => ({
        summaries: [summary("a")],
        errors: [{ sourceId: "opencode", message: "db locked" }],
      })),
    })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.scan()
    })
    expect(result.current.state).toMatchObject({
      status: "list",
      warnings: [{ sourceId: "opencode", message: "db locked" }],
    })
  })

  it("toggles a single selection off", async () => {
    const d = deps()
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.scan()
    })
    const key = summaryKey(summary("a").ref)
    act(() => result.current.toggle(key))
    expect(result.current.selected.has(key)).toBe(false)
    expect(result.current.selectedCount).toBe(1)
  })

  it("picks files and lists via the detected source", async () => {
    const d = deps()
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.pickFiles()
    })
    expect(d.detect).toHaveBeenCalled()
    expect(d.listSessionsForSource).toHaveBeenCalledWith("codex", expect.anything())
    expect(result.current.state.status).toBe("list")
  })

  it("errors when picked files match no source", async () => {
    const d = deps({ detect: jest.fn(() => null), listSessionsForSource: jest.fn(async () => []) })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.pickFiles()
    })
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "error" }))
  })

  it("goes idle when the picker is cancelled", async () => {
    const d = deps({ pick: jest.fn(async () => []) })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.pickFiles()
    })
    expect(result.current.state.status).toBe("idle")
  })
})
