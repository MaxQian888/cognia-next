jest.mock("./index", () => ({
  resolveScanInput: jest.fn(),
  listAllSessions: jest.fn(),
  listSessionsForSource: jest.fn(),
  importSessions: jest.fn(),
  getSessionSources: jest.fn(),
  detectSourceForPath: jest.fn(),
}))

import { runWatchImport, collectWatchRoots } from "./watch-import"
import * as idx from "./index"

const resolveScanInput = idx.resolveScanInput as jest.Mock
const listAllSessions = idx.listAllSessions as jest.Mock
const listSessionsForSource = idx.listSessionsForSource as jest.Mock
const importSessions = idx.importSessions as jest.Mock
const getSessionSources = idx.getSessionSources as jest.Mock
const detectSourceForPath = idx.detectSourceForPath as jest.Mock

const input = { fs: {}, home: "/home/u" }
const summary = (id: string, locator: string) => ({
  ref: { sourceId: "gemini-cli", originalSessionId: id, locator },
  title: id,
  sourceId: "gemini-cli",
  messageCount: 1,
  updatedAt: 0,
})

beforeEach(() => {
  jest.clearAllMocks()
  resolveScanInput.mockResolvedValue(input)
  importSessions.mockResolvedValue({ sessions: 1, messages: 2 })
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
