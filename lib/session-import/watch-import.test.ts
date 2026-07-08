jest.mock("./index", () => ({
  resolveScanInput: jest.fn(),
  listAllSessions: jest.fn(),
  importSessions: jest.fn(),
  getSessionSources: jest.fn(),
}))

import { runWatchImport, collectWatchRoots } from "./watch-import"
import * as idx from "./index"

const resolveScanInput = idx.resolveScanInput as jest.Mock
const listAllSessions = idx.listAllSessions as jest.Mock
const importSessions = idx.importSessions as jest.Mock
const getSessionSources = idx.getSessionSources as jest.Mock

const input = { fs: {}, home: "/home/u" }
const summary = (id: string, locator: string) => ({
  ref: { sourceId: "claude-code", originalSessionId: id, locator },
  title: id,
  sourceId: "claude-code",
  messageCount: 1,
  updatedAt: 0,
})

beforeEach(() => {
  jest.clearAllMocks()
  resolveScanInput.mockResolvedValue(input)
  importSessions.mockResolvedValue({ sessions: 1, messages: 2 })
})

describe("runWatchImport", () => {
  it("no-ops when nothing is found", async () => {
    listAllSessions.mockResolvedValue([])
    expect(await runWatchImport()).toEqual({ sessions: 0, messages: 0 })
    expect(importSessions).not.toHaveBeenCalled()
  })

  it("scopes to the changed file when it maps to a session", async () => {
    listAllSessions.mockResolvedValue([summary("a", "/p/a.jsonl"), summary("b", "/p/b.jsonl")])
    await runWatchImport({ changedPath: "/p/b.jsonl", projectId: "proj" })
    expect(importSessions).toHaveBeenCalledWith(
      [expect.objectContaining({ originalSessionId: "b" })],
      input,
      "proj"
    )
  })

  it("re-imports everything when the changed path matches no session", async () => {
    listAllSessions.mockResolvedValue([summary("a", "/p/a.jsonl"), summary("b", "/p/b.jsonl")])
    await runWatchImport({ changedPath: "/other/opencode.db" })
    const refs = importSessions.mock.calls[0][0]
    expect(refs).toHaveLength(2)
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
