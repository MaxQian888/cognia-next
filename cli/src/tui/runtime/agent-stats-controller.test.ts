import type { SessionFs, SessionSummary } from "@/lib/session-import"

import { runAgentStats, type AgentStatsDeps } from "./agent-stats-controller"
import type { TuiAction } from "../state/types"

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
