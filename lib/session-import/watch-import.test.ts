jest.mock("./index", () => ({
  resolveScanInput: jest.fn(),
  listAllSessions: jest.fn(),
  listSessionsForSource: jest.fn(),
  importSessions: jest.fn(),
  getSessionSources: jest.fn(),
  detectSourceForPath: jest.fn(),
}))

import { runWatchImport, collectWatchRoots, __resetWatchWatermarksForTesting } from "./watch-import"
import * as idx from "./index"

const resolveScanInput = idx.resolveScanInput as jest.Mock
const listAllSessions = idx.listAllSessions as jest.Mock
const listSessionsForSource = idx.listSessionsForSource as jest.Mock
const importSessions = idx.importSessions as jest.Mock
const getSessionSources = idx.getSessionSources as jest.Mock
const detectSourceForPath = idx.detectSourceForPath as jest.Mock

const input = { fs: {}, home: "/home/u" }
const summary = (id: string, locator: string, updatedAt = 0, watchRevision?: string) => ({
  ref: { sourceId: "gemini-cli", originalSessionId: id, locator },
  title: id,
  sourceId: "gemini-cli",
  messageCount: 1,
  updatedAt,
  watchRevision,
})

beforeEach(() => {
  jest.clearAllMocks()
  __resetWatchWatermarksForTesting()
  resolveScanInput.mockResolvedValue(input)
  importSessions.mockImplementation(async (refs, _input, _projectId, options) => {
    for (const ref of refs) options?.onRefParsed?.(ref)
    return { sessions: 1, messages: 2 }
  })
})

describe("runWatchImport", () => {
  it("no-ops when a full re-scan finds nothing", async () => {
    listAllSessions.mockResolvedValue([])
    expect(await runWatchImport()).toEqual({ sessions: 0, messages: 0 })
    expect(importSessions).not.toHaveBeenCalled()
    expect(detectSourceForPath).not.toHaveBeenCalled()
  })

  it("re-parses ONLY the changed file for a per-file source (no full scan)", async () => {
    detectSourceForPath.mockReturnValue({ id: "claude-code", summarizeFile: () => null })
    const changedPath = "/home/u/.claude/projects/enc/abc.jsonl"
    await runWatchImport({ changedPath, projectId: "proj" })

    expect(importSessions).toHaveBeenCalledWith(
      [{ sourceId: "claude-code", originalSessionId: "", locator: changedPath }],
      input,
      "proj"
    )
    // The whole point: the full history is never re-scanned.
    expect(listAllSessions).not.toHaveBeenCalled()
    expect(listSessionsForSource).not.toHaveBeenCalled()
  })

  it("re-scans ONLY the changed source when it has no per-file summary", async () => {
    detectSourceForPath.mockReturnValue({ id: "gemini-cli" }) // no summarizeFile
    listSessionsForSource.mockResolvedValue([
      summary("g1", "/home/u/.gemini/tmp/a"),
      summary("g2", "/home/u/.gemini/tmp/b"),
    ])
    await runWatchImport({ changedPath: "/home/u/.gemini/tmp/a", projectId: "proj" })

    expect(listSessionsForSource).toHaveBeenCalledWith("gemini-cli", input)
    expect(importSessions.mock.calls[0][0]).toHaveLength(2)
    expect(listAllSessions).not.toHaveBeenCalled()
  })

  it("re-imports only the sessions that moved since the last watch event", async () => {
    detectSourceForPath.mockReturnValue({ id: "opencode" }) // no summarizeFile
    const changedPath = "/home/u/.local/share/opencode/opencode.db"
    // First event: nothing seen yet, so the whole store is imported.
    listSessionsForSource.mockResolvedValue([
      summary("s1", changedPath, 100),
      summary("s2", changedPath, 200),
    ])
    await runWatchImport({ changedPath })
    expect(importSessions.mock.calls[0][0]).toHaveLength(2)

    // Second event: only s2 moved — s1 is not re-parsed or re-persisted.
    listSessionsForSource.mockResolvedValue([
      summary("s1", changedPath, 100),
      summary("s2", changedPath, 300),
    ])
    await runWatchImport({ changedPath })
    expect(importSessions.mock.calls[1][0]).toEqual([
      expect.objectContaining({ originalSessionId: "s2" }),
    ])
  })

  it("tracks each session independently when an older sibling moves", async () => {
    detectSourceForPath.mockReturnValue({ id: "opencode" })
    const changedPath = "/home/u/.local/share/opencode/opencode.db"
    listSessionsForSource.mockResolvedValue([
      summary("older", changedPath, 100),
      summary("newer", changedPath, 1000),
    ])
    await runWatchImport({ changedPath })

    listSessionsForSource.mockResolvedValue([
      summary("older", changedPath, 200),
      summary("newer", changedPath, 1000),
    ])
    await runWatchImport({ changedPath })

    expect(importSessions.mock.calls[1][0]).toEqual([
      expect.objectContaining({ originalSessionId: "older" }),
    ])
  })

  it("re-imports a session when its timestamp moves backward", async () => {
    detectSourceForPath.mockReturnValue({ id: "opencode" })
    const changedPath = "/home/u/.local/share/opencode/opencode.db"
    listSessionsForSource.mockResolvedValue([summary("restored", changedPath, 500)])
    await runWatchImport({ changedPath })

    listSessionsForSource.mockResolvedValue([summary("restored", changedPath, 100)])
    await runWatchImport({ changedPath })

    expect(importSessions).toHaveBeenCalledTimes(2)
  })

  it("re-imports when message count changes at the same timestamp", async () => {
    detectSourceForPath.mockReturnValue({ id: "gemini-cli" })
    const changedPath = "/home/u/.gemini/tmp/a"
    listSessionsForSource.mockResolvedValue([summary("s1", changedPath, 100)])
    await runWatchImport({ changedPath })

    listSessionsForSource.mockResolvedValue([
      { ...summary("s1", changedPath, 100), messageCount: 2 },
    ])
    await runWatchImport({ changedPath })

    expect(importSessions).toHaveBeenCalledTimes(2)
  })

  it("uses a source content revision when timestamps and counts are unchanged", async () => {
    detectSourceForPath.mockReturnValue({ id: "opencode" })
    const changedPath = "/home/u/.local/share/opencode/opencode.db"
    listSessionsForSource.mockResolvedValue([summary("s1", changedPath, 100, "rev-a")])
    await runWatchImport({ changedPath })

    listSessionsForSource.mockResolvedValue([summary("s1", changedPath, 100, "rev-b")])
    await runWatchImport({ changedPath })

    expect(importSessions).toHaveBeenCalledTimes(2)
  })

  it("no-ops when nothing moved since the last watch event", async () => {
    detectSourceForPath.mockReturnValue({ id: "opencode" })
    const changedPath = "/home/u/.local/share/opencode/opencode.db"
    listSessionsForSource.mockResolvedValue([summary("s1", changedPath, 100)])
    await runWatchImport({ changedPath })
    importSessions.mockClear()
    expect(await runWatchImport({ changedPath })).toEqual({ sessions: 0, messages: 0 })
    expect(importSessions).not.toHaveBeenCalled()
  })

  it("keeps a per-source watermark, so one source never gates another", async () => {
    const openPath = "/home/u/.local/share/opencode/opencode.db"
    detectSourceForPath.mockReturnValue({ id: "opencode" })
    listSessionsForSource.mockResolvedValue([summary("s1", openPath, 500)])
    await runWatchImport({ changedPath: openPath })

    // A different source with older timestamps still imports in full.
    detectSourceForPath.mockReturnValue({ id: "gemini-cli" })
    listSessionsForSource.mockResolvedValue([summary("g1", "/home/u/.gemini/tmp/a", 10)])
    importSessions.mockClear()
    await runWatchImport({ changedPath: "/home/u/.gemini/tmp/a" })
    expect(importSessions.mock.calls[0][0]).toHaveLength(1)
  })

  it("does not advance the watermark when every summary lacks a timestamp", async () => {
    detectSourceForPath.mockReturnValue({ id: "gemini-cli" })
    listSessionsForSource.mockResolvedValue([summary("g1", "/home/u/.gemini/tmp/a", 0)])
    await runWatchImport({ changedPath: "/home/u/.gemini/tmp/a" })
    importSessions.mockClear()
    // Timestamp-less sources keep re-importing (idempotent) rather than
    // silently going dark after the first event.
    await runWatchImport({ changedPath: "/home/u/.gemini/tmp/a" })
    expect(importSessions.mock.calls[0][0]).toHaveLength(1)
  })

  it("retries changed sessions when persistence fails", async () => {
    detectSourceForPath.mockReturnValue({ id: "opencode" })
    const changedPath = "/home/u/.local/share/opencode/opencode.db"
    listSessionsForSource.mockResolvedValue([summary("s1", changedPath, 100)])
    importSessions.mockRejectedValueOnce(new Error("db locked"))

    await expect(runWatchImport({ changedPath })).rejects.toThrow("db locked")
    await runWatchImport({ changedPath })

    expect(importSessions).toHaveBeenCalledTimes(2)
    expect(importSessions.mock.calls[1][0]).toEqual([
      expect.objectContaining({ originalSessionId: "s1" }),
    ])
  })

  it("retries sessions that the importer could not parse", async () => {
    detectSourceForPath.mockReturnValue({ id: "opencode" })
    const changedPath = "/home/u/.local/share/opencode/opencode.db"
    listSessionsForSource.mockResolvedValue([summary("s1", changedPath, 100)])
    importSessions.mockImplementationOnce(async () => ({ sessions: 0, messages: 0 }))

    await runWatchImport({ changedPath })
    await runWatchImport({ changedPath })

    expect(importSessions).toHaveBeenCalledTimes(2)
  })

  it("no-ops when the changed source re-scan is empty", async () => {
    detectSourceForPath.mockReturnValue({ id: "gemini-cli" })
    listSessionsForSource.mockResolvedValue([])
    expect(await runWatchImport({ changedPath: "/home/u/.gemini/tmp/a" })).toEqual({
      sessions: 0,
      messages: 0,
    })
    expect(importSessions).not.toHaveBeenCalled()
  })

  it("falls back to a full re-scan when the path matches no known root", async () => {
    detectSourceForPath.mockReturnValue(undefined)
    listAllSessions.mockResolvedValue([summary("a", "/p/a"), summary("b", "/p/b")])
    await runWatchImport({ changedPath: "/somewhere/else.db" })
    expect(importSessions.mock.calls[0][0]).toHaveLength(2)
  })
})

describe("collectWatchRoots", () => {
  it("unions and dedupes scan roots across sources", async () => {
    getSessionSources.mockReturnValue([
      { scanRoots: () => ["/home/u/.claude/projects"] },
      { scanRoots: () => ["/home/u/.codex/sessions", "/home/u/.claude/projects"] },
      { scanRoots: () => [] },
    ])
    const roots = await collectWatchRoots()
    expect(roots.sort()).toEqual(["/home/u/.claude/projects", "/home/u/.codex/sessions"])
  })
})
