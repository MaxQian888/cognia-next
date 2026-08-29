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
    importSessions: jest.fn(async () => ({ lossBySource: {}, sessions: 2, messages: 6 })),
    pick: jest.fn(async () => [{ name: "a.jsonl", path: "/p/a.jsonl", content: "{}" }]),
    detect: jest.fn(() => ["codex"]),
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
      "proj-1",
      expect.objectContaining({ signal: expect.anything(), onProgress: expect.any(Function) })
    )
    expect(result.current.state).toMatchObject({
      status: "done",
      sessionsAdded: 2,
      messagesAdded: 6,
    })
  })

  it("retains per-session graph details returned by the importer", async () => {
    const details = [
      {
        sourceId: "codex",
        canonicalSessionId: "canon:codex:root",
        sourceVersion: "0.150.1",
        loss: { fidelity: "structured" as const, losses: [] },
      },
    ]
    const d = deps({
      importSessions: jest.fn(async () => ({
        lossBySource: {},
        sessions: 1,
        messages: 2,
        details,
      })),
    })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => result.current.scan())
    await act(async () => result.current.importSelected())
    expect(result.current.state).toMatchObject({ status: "done", details })
  })

  it("surfaces live progress and cancels an in-flight import, keeping partial work", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let captured: AbortSignal | undefined
    const d = deps({
      importSessions: jest.fn(async (_refs, _in, _pid, opts) => {
        captured = opts?.signal
        opts?.onProgress?.({ phase: "parsing", done: 1, total: 2 })
        await gate
        return { lossBySource: {}, sessions: 1, messages: 3 }
      }),
    })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.scan()
    })

    let importDone: Promise<void> | undefined
    await act(async () => {
      importDone = result.current.importSelected()
      await Promise.resolve()
    })
    // Progress made it into the importing state.
    expect(result.current.state).toMatchObject({
      status: "importing",
      phase: "parsing",
      done: 1,
      total: 2,
    })

    act(() => result.current.cancelImport())
    expect(captured?.aborted).toBe(true)

    await act(async () => {
      release?.()
      await importDone
    })
    expect(result.current.state).toMatchObject({
      status: "done",
      sessionsAdded: 1,
      cancelled: true,
    })
  })

  it("aborts an in-flight import when reset (dialog closed mid-run)", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let captured: AbortSignal | undefined
    const d = deps({
      importSessions: jest.fn(async (_refs, _in, _pid, opts) => {
        captured = opts?.signal
        await gate
        return { lossBySource: {}, sessions: 0, messages: 0 }
      }),
    })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.scan()
    })
    let importDone: Promise<void> | undefined
    await act(async () => {
      importDone = result.current.importSelected()
      await Promise.resolve()
    })
    act(() => result.current.reset())
    expect(captured?.aborted).toBe(true)
    expect(result.current.state.status).toBe("idle")
    await act(async () => {
      release?.()
      await importDone
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
    const d = deps({ detect: jest.fn(() => []), listSessionsForSource: jest.fn(async () => []) })
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

  it("offers the registered sources' extensions, not a hard-coded pair", async () => {
    // A fixed ["jsonl","json"] filter made Aider (.md) and OpenCode (.db)
    // unselectable; the filter has to come from the adapters.
    const acceptedExtensions = jest.fn(() => ["jsonl", "json", "md", "db"])
    const d = deps({ acceptedExtensions })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.pickFiles()
    })

    expect(acceptedExtensions).toHaveBeenCalled()
    expect(d.pick).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ extensions: ["jsonl", "json", "md", "db"] })],
      })
    )
  })

  it("lists across EVERY source that claims a mixed pick", async () => {
    // Selecting a Claude Code transcript and a Codex rollout together used to
    // import whichever source detection happened to name first and silently
    // drop the other.
    const d = deps({
      detect: jest.fn(() => ["claude-code", "codex"]),
      listSessionsForSource: jest.fn(async (id: string) => [summary(`${id}-1`)]),
    })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.pickFiles()
    })
    expect(d.listSessionsForSource).toHaveBeenCalledTimes(2)
    expect(result.current.state).toMatchObject({ status: "list" })
    const state = result.current.state as { status: "list"; summaries: unknown[] }
    expect(state.summaries).toHaveLength(2)
  })

  it("surfaces a claiming source that could not be read, instead of dropping it", async () => {
    const d = deps({
      detect: jest.fn(() => ["claude-code", "opencode"]),
      listSessionsForSource: jest.fn(async (id: string) => {
        if (id === "opencode") throw new Error("database is locked")
        return [summary("ok")]
      }),
    })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.pickFiles()
    })
    expect(result.current.state).toMatchObject({
      status: "list",
      warnings: [{ sourceId: "opencode", message: "database is locked" }],
    })
  })

  it("an explicit source id still narrows the pick to that source alone", async () => {
    const d = deps({ detect: jest.fn(() => ["claude-code", "codex"]) })
    const { result } = renderHook(() => useSessionImport(d))
    await act(async () => {
      await result.current.pickFiles("codex")
    })
    expect(d.detect).not.toHaveBeenCalled()
    expect(d.listSessionsForSource).toHaveBeenCalledTimes(1)
    expect(d.listSessionsForSource).toHaveBeenCalledWith("codex", expect.anything())
  })
})
