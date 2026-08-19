/** @jest-environment jsdom */
// Chat-history discovery for the first-run scan step (ADR-0122 × ADR-0062).

import { act, renderHook, waitFor } from "@testing-library/react"

import { summarizeHistory, useHistoryImport } from "./use-history-import"
import type { SessionScanInput, SessionSummary } from "@/lib/session-import"

jest.mock("@/lib/session-import", () => ({
  ...jest.requireActual("@/lib/session-import"),
  getSessionSource: (id: string) =>
    id === "unknown-source" ? undefined : { id, displayName: `Label:${id}` },
}))

function summary(sourceId: string, id: string): SessionSummary {
  return {
    ref: { sourceId, originalSessionId: id, locator: `/tmp/${id}` },
    title: id,
    sourceId,
    messageCount: 2,
    updatedAt: 1_000,
  }
}

const SCAN_INPUT = {} as SessionScanInput

function deps(over: Record<string, unknown> = {}) {
  return {
    resolveScanInput: async () => SCAN_INPUT,
    scanAllSources: async () => ({
      summaries: [
        summary("claude-code", "a"),
        summary("gemini-cli", "b"),
        summary("gemini-cli", "c"),
      ],
      errors: [],
    }),
    importSessions: async () => ({ sessions: 3, messages: 12, lossBySource: {} }),
    ...over,
  } as never
}

describe("summarizeHistory", () => {
  it("groups by source, largest first, resolving adapter display names", () => {
    expect(
      summarizeHistory([
        summary("claude-code", "a"),
        summary("gemini-cli", "b"),
        summary("gemini-cli", "c"),
      ])
    ).toEqual([
      { sourceId: "gemini-cli", label: "Label:gemini-cli", sessions: 2 },
      { sourceId: "claude-code", label: "Label:claude-code", sessions: 1 },
    ])
  })

  it("keeps a row whose adapter is no longer registered", () => {
    // A plugin source can unregister between the scan and the render; dropping
    // the row would under-report conversations that really are importable.
    expect(summarizeHistory([summary("unknown-source", "a")])).toEqual([
      { sourceId: "unknown-source", label: "unknown-source", sessions: 1 },
    ])
  })

  it("returns nothing for an empty scan", () => {
    expect(summarizeHistory([])).toEqual([])
  })
})

describe("useHistoryImport", () => {
  it("scans on the desktop and reports the per-source breakdown", async () => {
    const { result } = renderHook(() => useHistoryImport({ shell: "tauri", deps: deps() }))

    await waitFor(() => expect(result.current.phase).toBe("found"))
    expect(result.current.total).toBe(3)
    expect(result.current.sources.map((s) => s.sourceId)).toEqual(["gemini-cli", "claude-code"])
    expect(result.current.partial).toBe(false)
  })

  it("does not scan off the desktop", async () => {
    const scanAllSources = jest.fn()
    const { result } = renderHook(() =>
      useHistoryImport({ shell: "mobile-standalone", deps: deps({ scanAllSources }) })
    )
    await Promise.resolve()
    expect(scanAllSources).not.toHaveBeenCalled()
    expect(result.current.phase).toBe("idle")
  })

  it("scans exactly once per mount", async () => {
    const scanAllSources = jest.fn(async () => ({ summaries: [summary("codex", "a")], errors: [] }))
    const { result, rerender } = renderHook(() =>
      useHistoryImport({ shell: "tauri", deps: deps({ scanAllSources }) })
    )
    await waitFor(() => expect(result.current.phase).toBe("found"))
    rerender()
    rerender()
    expect(scanAllSources).toHaveBeenCalledTimes(1)
  })

  it("imports everything found into the active workspace", async () => {
    const importSessions = jest.fn(async (refs: unknown[], _input: unknown, projectId?: string) => {
      void refs
      void projectId
      return { sessions: 3, messages: 12, lossBySource: {} }
    })
    const { result } = renderHook(() =>
      useHistoryImport({ shell: "tauri", deps: deps({ importSessions }) })
    )
    await waitFor(() => expect(result.current.phase).toBe("found"))

    await act(async () => {
      await result.current.importAll("w1")
    })

    expect(importSessions).toHaveBeenCalledTimes(1)
    // Every discovered ref, stamped with the workspace.
    expect(importSessions.mock.calls[0][0]).toHaveLength(3)
    expect(importSessions.mock.calls[0][2]).toBe("w1")
    expect(result.current.phase).toBe("done")
    expect(result.current.imported).toBe(3)
    expect(result.current.progress).toBe(1)
  })

  it("reports a partially-readable scan", async () => {
    const { result } = renderHook(() =>
      useHistoryImport({
        shell: "tauri",
        deps: deps({
          scanAllSources: async () => ({
            summaries: [summary("codex", "a")],
            errors: [{ sourceId: "opencode", message: "database locked" }],
          }),
        }),
      })
    )
    await waitFor(() => expect(result.current.phase).toBe("found"))
    expect(result.current.partial).toBe(true)
  })

  it("collapses an empty disk and a failed scan into the same silent state", async () => {
    const empty = renderHook(() =>
      useHistoryImport({
        shell: "tauri",
        deps: deps({ scanAllSources: async () => ({ summaries: [], errors: [] }) }),
      })
    )
    await waitFor(() => expect(empty.result.current.phase).toBe("empty"))

    const failed = renderHook(() =>
      useHistoryImport({
        shell: "tauri",
        deps: deps({
          resolveScanInput: async () => {
            throw new Error("home unavailable")
          },
        }),
      })
    )
    // A first-run user cannot act on "the OpenCode database could not be read",
    // and the step must never block the path to a first output.
    await waitFor(() => expect(failed.result.current.phase).toBe("empty"))
  })
})
