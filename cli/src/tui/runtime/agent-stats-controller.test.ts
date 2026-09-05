import { promises as fsp } from "node:fs"
import os from "node:os"
import path from "node:path"
import * as sessionFs from "./node-session-fs"
import type { SessionFs, SessionSummary } from "@/lib/session-import"

import { runAgentStats, type AgentStatsDeps } from "./agent-stats-controller"
import type { TuiAction } from "../state/types"

jest.mock("./node-session-fs", () => {
  const actual = jest.requireActual("./node-session-fs")
  return { ...actual, nodeSessionFs: jest.fn(actual.nodeSessionFs) }
})

jest.mock("./node-opencode-reader", () => ({
  ...jest.requireActual("./node-opencode-reader"),
  isNodeSqliteAvailable: jest.fn(async () => false),
}))

const NOOP_FS = {} as unknown as SessionFs

function harness(over: Partial<AgentStatsDeps> = {}) {
  const actions: TuiAction[] = []
  const deps: AgentStatsDeps = {
    dispatch: (a) => actions.push(a),
    osHome: "/home/u",
    fs: NOOP_FS,
    installOpencodeReader: () => {},
    ...over,
  }
  return { actions, deps }
}

const summary = (source: string, id: string, updatedAt = 1): SessionSummary => ({
  ref: { sourceId: source, originalSessionId: id, locator: id },
  title: id,
  sourceId: source,
  messageCount: 1,
  updatedAt,
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const convOf = (source: string, id: string): any => ({
  session: { id: `import:${source}:${id}`, title: id, createdAt: 1, updatedAt: 2 },
  messages: [
    {
      id: "x",
      sessionId: `import:${source}:${id}`,
      role: "assistant",
      createdAt: 1,
      parts: [{ type: "tool-Bash" }],
      metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
    },
  ],
})

describe("runAgentStats", () => {
  it("dispatches a NOTICE when no sessions are found", async () => {
    const { actions, deps } = harness({ listSessions: async () => [] })
    await runAgentStats(deps)
    expect(actions).toHaveLength(1)
    expect(actions[0].type).toBe("NOTICE")
  })

  it("parses, derives usage, and opens the panel", async () => {
    const { actions, deps } = harness({
      listSessions: async () => [summary("claude-code", "a")],
      parse: async () => [convOf("claude-code", "a")],
    })
    await runAgentStats(deps)
    const open = actions.find((a) => a.type === "OVERLAY_OPEN")
    expect(open).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overlay = (open as any).overlay
    expect(overlay.kind).toBe("agentStats")
    expect(overlay.overview.conversations).toBe(1)
    expect(overlay.rows[0].source).toBe("claude-code")
    expect(overlay.overview.tokens).toBe(15)
    expect(overlay.items).toHaveLength(1)
  })

  it("discloses truncation via notes and only parses the cap", async () => {
    const summaries = [
      summary("codex", "s0", 0),
      summary("codex", "s1", 1),
      summary("codex", "s2", 2),
    ]
    let parsedCount = 0
    const { actions, deps } = harness({
      maxConversations: 2,
      listSessions: async () => summaries,
      parse: async (refs) => {
        parsedCount = refs.length
        return refs.map((r) => convOf("codex", r.originalSessionId))
      },
    })
    await runAgentStats(deps)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overlay = (actions.find((a) => a.type === "OVERLAY_OPEN") as any).overlay
    expect(parsedCount).toBe(2)
    expect(overlay.overview.notes[0]).toContain("2")
  })

  it("degrades to a NOTICE when listing throws", async () => {
    const { actions, deps } = harness({
      listSessions: async () => {
        throw new Error("boom")
      },
    })
    await runAgentStats(deps)
    expect(actions[0].type).toBe("NOTICE")
  })

  it("opens an empty panel when parsing throws", async () => {
    const { actions, deps } = harness({
      listSessions: async () => [summary("codex", "a")],
      parse: async () => {
        throw new Error("boom")
      },
    })
    await runAgentStats(deps)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overlay = (actions.find((a) => a.type === "OVERLAY_OPEN") as any).overlay
    expect(overlay.overview.conversations).toBe(0)
  })

  it("installs the Node OpenCode reader by default (no seam)", async () => {
    // Exercise the default `installOpencodeReader` branch without the seam.
    const { actions, deps } = harness({
      installOpencodeReader: undefined,
      listSessions: async () => [],
    })
    await runAgentStats(deps)
    expect(actions[0].type).toBe("NOTICE")
  })

  it("aborts early when the signal is already aborted after listing", async () => {
    const controller = new AbortController()
    const { actions, deps } = harness({
      signal: controller.signal,
      listSessions: async () => {
        controller.abort()
        return [summary("codex", "a")]
      },
    })
    await runAgentStats(deps)
    expect(actions.find((a) => a.type === "OVERLAY_OPEN")).toBeUndefined()
  })
})

describe("agent stats memory limits", () => {
  afterEach(() => jest.restoreAllMocks())

  it("discloses oversized files even when the scan yields no sessions", async () => {
    jest.mocked(sessionFs.nodeSessionFs).mockImplementation((options) => ({
      ...NOOP_FS,
      readTextFile: async () => {
        options?.onLimit?.("file")
        throw new sessionFs.SessionReadLimitError("file")
      },
    }))
    const { actions, deps } = harness({
      fs: undefined,
      listSessions: async (input) => {
        await input.fs.readTextFile("oversized").catch(() => {})
        return []
      },
    })
    await runAgentStats(deps)
    expect(actions[0]).toMatchObject({
      type: "NOTICE",
      message: expect.stringContaining("incomplete"),
    })
  })

  it("uses a fresh aggregate budget for retained parses and discloses partial statistics", async () => {
    const makeFs = jest.mocked(sessionFs.nodeSessionFs).mockImplementation((options) => ({
      ...NOOP_FS,
      readTextFile: async () => {
        options?.onLimit?.("file")
        options?.onLimit?.("budget")
        throw new sessionFs.SessionReadLimitError("budget")
      },
    }))
    const { actions, deps } = harness({
      fs: undefined,
      listSessions: async (input) => {
        await input.fs.readTextFile("large").catch(() => {})
        return [summary("codex", "a")]
      },
      parse: async (_refs, input) => {
        await input.fs.readTextFile("budget").catch(() => {})
        return [convOf("codex", "a")]
      },
    })
    await runAgentStats(deps)
    expect(makeFs.mock.calls.slice(-2).map(([options]) => options?.maxTotalBytes)).toEqual([
      64 * 1024 * 1024,
      64 * 1024 * 1024,
    ])
    const action = actions.find((a) => a.type === "OVERLAY_OPEN")
    if (!action || action.type !== "OVERLAY_OPEN" || action.overlay.kind !== "agentStats")
      throw new Error("missing stats")
    expect(action.overlay.overview.notes.join(" ")).toContain("16 MiB")
    expect(action.overlay.overview.notes.join(" ")).toContain("64 MiB")
  })

  it("reports discovery budget exhaustion even when no summaries survive", async () => {
    jest.mocked(sessionFs.nodeSessionFs).mockImplementation((options) => ({
      ...NOOP_FS,
      readTextFile: async () => {
        options?.onLimit?.("budget")
        throw new sessionFs.SessionReadLimitError("budget")
      },
    }))
    const { actions, deps } = harness({
      fs: undefined,
      listSessions: async (input) => {
        await input.fs.readTextFile("budget")
        return []
      },
    })
    await runAgentStats(deps)
    expect(actions).toEqual([
      {
        type: "NOTICE",
        message: expect.stringMatching(/Discovery.*64 MiB.*incomplete/),
      },
    ])
  })

  it("bounds real discovery reads and gives analysis a fresh budget", async () => {
    const actual = jest.requireActual<typeof sessionFs>("./node-session-fs")
    jest.mocked(sessionFs.nodeSessionFs).mockImplementation(actual.nodeSessionFs)
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "stats-phase-budget-"))
    const file = path.join(dir, "finite.jsonl")
    const handle = await fsp.open(file, "w")
    await handle.truncate(16 * 1024 * 1024)
    await handle.close()
    try {
      const { actions, deps } = harness({
        fs: undefined,
        listSessions: async (input) => {
          for (let i = 0; i < 4; i++)
            expect((await input.fs.readTextFile(file)).length).toBe(16 * 1024 * 1024)
          await expect(input.fs.readTextFile(file)).rejects.toMatchObject({ reason: "budget" })
          return [summary("codex", "a")]
        },
        parse: async (_refs, input) => {
          expect((await input.fs.readTextFile(file)).length).toBe(16 * 1024 * 1024)
          return [convOf("codex", "a")]
        },
      })
      await runAgentStats(deps)
      const action = actions.find((a) => a.type === "OVERLAY_OPEN")
      if (!action || action.type !== "OVERLAY_OPEN" || action.overlay.kind !== "agentStats")
        throw new Error("missing stats")
      expect(action.overlay.overview.conversations).toBe(1)
      expect(action.overlay.overview.notes.join(" ")).toMatch(/Discovery.*64 MiB.*incomplete/)
      expect(action.overlay.overview.notes.join(" ")).not.toContain("Analysis reads")
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it("does no scanning when already cancelled", async () => {
    const listSessions = jest.fn()
    const { deps } = harness({ signal: AbortSignal.abort(), listSessions })
    await runAgentStats(deps)
    expect(listSessions).not.toHaveBeenCalled()
  })
})

it("discloses unavailable SQLite and aborts after an in-flight parse", async () => {
  const { actions, deps } = harness({
    installOpencodeReader: undefined,
    listSessions: async () => [summary("codex", "one")],
    parse: async () => [convOf("codex", "one")],
  })
  await runAgentStats(deps)
  const open = actions.find((a) => a.type === "OVERLAY_OPEN")
  if (!open || open.type !== "OVERLAY_OPEN" || open.overlay.kind !== "agentStats")
    throw new Error("missing stats")
  expect(open.overlay.overview.notes.join(" ")).toContain("node:sqlite")
  const controller = new AbortController()
  const cancelled = harness({
    signal: controller.signal,
    listSessions: async () => [summary("codex", "one")],
    parse: async () => {
      controller.abort()
      return []
    },
  })
  await runAgentStats(cancelled.deps)
  expect(cancelled.actions).toEqual([])
})
