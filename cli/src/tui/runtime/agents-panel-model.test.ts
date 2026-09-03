import {
  agentRowBadge,
  agentRowHint,
  agentRowTask,
  agentSummary,
  buildAgentPanelRows,
  buildLiveAgentTreeRows,
  formatElapsed,
  formatTokenCount,
  liveAgentActivity,
  orderRowsHierarchically,
  refreshAgentPanelRows,
  type AgentPanelRow,
  type AgentPanelSources,
} from "./agents-panel-model"
import { stringWidth } from "../markdown/width"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import type { CliBackgroundRunInfo } from "../../agent/subagent-background-tasks"
import type { SubagentLiveEntry } from "../../agent/subagent-live-output"

const journal = (over: Partial<BackgroundTaskJournalRecord>): BackgroundTaskJournalRecord => ({
  runId: "r1",
  kind: "subagent",
  subagentId: "reviewer",
  prompt: "review the diff",
  sessionId: "s1",
  host: "cli",
  status: "done",
  startedAt: 1_000,
  ...over,
})

const live = (over: Partial<CliBackgroundRunInfo>): CliBackgroundRunInfo => ({
  runId: "r1",
  subagentId: "reviewer",
  status: "running",
  startedAt: 1_000,
  sessionId: "s",
  ...over,
})

const liveEntry = (over: Partial<SubagentLiveEntry>): SubagentLiveEntry => ({
  liveId: "live-1",
  name: "reviewer",
  task: "review the diff",
  sessionId: "s1",
  status: "running",
  startedAt: 1_000,
  text: "",
  thinking: "",
  tools: [],
  timeline: [],
  toolUseCount: 0,
  approxChars: 0,
  version: 0,
  ...over,
})

const sources = (over: Partial<AgentPanelSources>): AgentPanelSources => ({
  inflight: [],
  live: [],
  backgroundRuns: [],
  journalRecords: [],
  ...over,
})

describe("buildAgentPanelRows", () => {
  it("lists in-turn dispatches above background rows", () => {
    const rows = buildAgentPanelRows(
      sources({
        inflight: [{ callKey: "k1", name: "scout", task: "search" }],
        journalRecords: [journal({ runId: "bg1", status: "done", startedAt: 5_000 })],
      })
    )
    expect(rows.map((r) => r.id)).toEqual(["inflight:k1", "bg:bg1"])
    expect(rows[0]).toMatchObject({ kind: "inflight", status: "running", name: "scout" })
  })

  it("carries the journal prompt + settled output onto background rows", () => {
    const rows = buildAgentPanelRows(
      sources({
        journalRecords: [
          journal({ runId: "bg1", status: "done", resultText: "the summary" }),
          journal({ runId: "bg2", status: "error", error: "boom", subagentId: "qa" }),
        ],
      })
    )
    const done = rows.find((r) => r.runId === "bg1")
    const errored = rows.find((r) => r.runId === "bg2")
    expect(done).toMatchObject({ task: "review the diff", output: "the summary", status: "done" })
    expect(errored).toMatchObject({ output: "boom", status: "error", name: "qa" })
  })

  it("lets the live registry override a stale journal status", () => {
    const rows = buildAgentPanelRows(
      sources({
        backgroundRuns: [live({ runId: "bg1", status: "running" })],
        // Journal still reads done (write hasn't caught up) — live wins.
        journalRecords: [journal({ runId: "bg1", status: "done" })],
      })
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ runId: "bg1", status: "running" })
  })

  it("surfaces a live run the journal has not flushed yet", () => {
    const rows = buildAgentPanelRows(
      sources({ backgroundRuns: [live({ runId: "bg9", subagentId: "writer" })] })
    )
    expect(rows).toEqual([
      expect.objectContaining({ id: "bg:bg9", kind: "background", name: "writer", task: "" }),
    ])
  })

  it("ignores non-cli journal records", () => {
    const rows = buildAgentPanelRows(
      sources({ journalRecords: [journal({ host: "renderer", runId: "bgR" })] })
    )
    expect(rows).toEqual([])
  })

  it("orders running before interrupted before error before done, then newest first", () => {
    const rows = buildAgentPanelRows(
      sources({
        backgroundRuns: [live({ runId: "run", status: "running", startedAt: 10 })],
        journalRecords: [
          journal({ runId: "run", status: "running", startedAt: 10 }),
          journal({ runId: "done-old", status: "done", startedAt: 1 }),
          journal({ runId: "done-new", status: "done", startedAt: 9 }),
          journal({ runId: "intr", status: "interrupted", startedAt: 2 }),
          journal({ runId: "err", status: "error", startedAt: 3 }),
        ],
      })
    )
    expect(rows.map((r) => r.runId)).toEqual(["run", "intr", "err", "done-new", "done-old"])
  })

  it("turns a foreground live entry into an openable in-turn row with a liveId", () => {
    const rows = buildAgentPanelRows(
      sources({ live: [liveEntry({ liveId: "live-7", text: "streaming…" })] })
    )
    expect(rows).toEqual([
      expect.objectContaining({
        id: "live:live-7",
        kind: "inflight",
        liveId: "live-7",
        status: "running",
        output: "streaming…",
      }),
    ])
  })

  it("classifies a live entry sharing a background runId as background and dedups the journal", () => {
    const rows = buildAgentPanelRows(
      sources({
        live: [liveEntry({ liveId: "bg5", status: "done", text: "final" })],
        backgroundRuns: [live({ runId: "bg5", status: "done" })],
        journalRecords: [journal({ runId: "bg5", status: "done", resultText: "final" })],
      })
    )
    // One row only — the live entry wins; the journal record is deduped away.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "bg:bg5",
      kind: "background",
      runId: "bg5",
      liveId: "bg5",
      status: "done",
    })
  })

  it("drops the in-turn tool-cell fallback when a live entry is running", () => {
    const rows = buildAgentPanelRows(
      sources({
        inflight: [{ callKey: "k1", name: "scout", task: "search" }],
        live: [liveEntry({ liveId: "live-9" })],
      })
    )
    expect(rows.map((r) => r.id)).toEqual(["live:live-9"])
  })

  it("keeps the tool-cell fallback when no live entry is running (only settled)", () => {
    const rows = buildAgentPanelRows(
      sources({
        inflight: [{ callKey: "k1", name: "scout", task: "search" }],
        live: [liveEntry({ liveId: "live-done", status: "done" })],
      })
    )
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(["live:live-done", "inflight:k1"]))
    expect(rows).toHaveLength(2)
  })

  it("keeps a settled journal record the live store has already evicted", () => {
    const rows = buildAgentPanelRows(
      sources({
        live: [],
        journalRecords: [journal({ runId: "bg-old", status: "done", resultText: "kept" })],
      })
    )
    expect(rows).toEqual([
      expect.objectContaining({ id: "bg:bg-old", output: "kept", status: "done" }),
    ])
  })
})

describe("refreshAgentPanelRows", () => {
  it("moves a live row's status/tokens while keeping journal-only rows", () => {
    const prev = buildAgentPanelRows(
      sources({
        live: [liveEntry({ liveId: "live-1", toolUseCount: 2, approxChars: 400 })],
        journalRecords: [journal({ runId: "bg-old", status: "done", resultText: "kept" })],
      })
    )
    const next = refreshAgentPanelRows(
      prev,
      [liveEntry({ liveId: "live-1", status: "done", toolUseCount: 9, usageTokens: 5_000 })],
      []
    )
    expect(next.find((r) => r.id === "live:live-1")).toMatchObject({
      status: "done",
      toolUses: 9,
      tokens: 5_000,
    })
    expect(next.find((r) => r.id === "bg:bg-old")).toMatchObject({ output: "kept" })
  })

  it("adds a live entry that appeared after the panel opened", () => {
    const next = refreshAgentPanelRows([], [liveEntry({ liveId: "live-new" })], [])
    expect(next.map((r) => r.id)).toEqual(["live:live-new"])
  })

  it("keeps a background live entry classified as background via its prior runId", () => {
    const prev: AgentPanelRow[] = [
      {
        id: "bg:bg7",
        kind: "background",
        name: "reviewer",
        task: "t",
        status: "running",
        runId: "bg7",
        liveId: "bg7",
      },
    ]
    const next = refreshAgentPanelRows(prev, [liveEntry({ liveId: "bg7", status: "done" })], [])
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: "bg:bg7", kind: "background", status: "done" })
  })

  it("drops stale in-turn fallback rows once a live entry is running", () => {
    const prev: AgentPanelRow[] = [
      { id: "inflight:k1", kind: "inflight", name: "scout", task: "", status: "running" },
    ]
    const next = refreshAgentPanelRows(prev, [liveEntry({ liveId: "live-1" })], [])
    expect(next.map((r) => r.id)).toEqual(["live:live-1"])
  })

  it("corrects a kept background row's status from the live registry", () => {
    const prev: AgentPanelRow[] = [
      { id: "bg:bg1", kind: "background", name: "n", task: "", status: "running", runId: "bg1" },
    ]
    const next = refreshAgentPanelRows(prev, [], [live({ runId: "bg1", status: "done" })])
    expect(next[0]).toMatchObject({ id: "bg:bg1", status: "done" })
  })
})

describe("formatTokenCount", () => {
  it("formats plain, thousands, and millions", () => {
    expect(formatTokenCount(842)).toBe("842")
    expect(formatTokenCount(115_040)).toBe("115.0k")
    expect(formatTokenCount(2_340_000)).toBe("2.3M")
    expect(formatTokenCount(-3)).toBe("0")
  })
})

describe("liveAgentActivity", () => {
  const tool = (name: string, status: "running" | "done" = "running") => ({ name, status })

  it("groups running tools into verb buckets, CC style", () => {
    const entry = liveEntry({
      tools: [
        tool("grep"),
        tool("glob"),
        tool("grep"),
        tool("read"),
        tool("read", "done"),
        tool("bash"),
      ],
    })
    expect(liveAgentActivity(entry)).toBe(
      "Searching for 3 patterns, reading 1 file, running 1 command…"
    )
  })

  it("covers the edit / fetch buckets and the many-unknown-tools fallback", () => {
    expect(
      liveAgentActivity(liveEntry({ tools: [tool("edit"), tool("write"), tool("webfetch")] }))
    ).toBe("Editing 2 files, fetching 1 page…")
    expect(liveAgentActivity(liveEntry({ tools: [tool("mystery_a"), tool("mystery_b")] }))).toBe(
      "Using 2 tools…"
    )
  })

  it("strips tool namespaces before bucketing and names unknown tools", () => {
    const entry = liveEntry({
      tools: [tool("mcp__cognia-tools__read"), tool("mcp__codegraph__codegraph_context")],
    })
    expect(liveAgentActivity(entry)).toBe("Reading 1 file, using codegraph:codegraph_context…")
  })

  it("falls back to the timeline tail when no tool is running", () => {
    expect(liveAgentActivity(liveEntry({}))).toBe("Starting…")
    expect(liveAgentActivity(liveEntry({ timeline: [{ kind: "thinking", text: "hmm" }] }))).toBe(
      "Thinking…"
    )
    expect(liveAgentActivity(liveEntry({ timeline: [{ kind: "text", text: "so" }] }))).toBe(
      "Responding…"
    )
    expect(
      liveAgentActivity(
        liveEntry({ timeline: [{ kind: "tool", name: "read", summary: "", status: "done" }] })
      )
    ).toBe("Working…")
  })
})

describe("buildLiveAgentTreeRows", () => {
  it("lists running entries oldest-first with a stats header + activity line", () => {
    const rows = buildLiveAgentTreeRows([
      liveEntry({
        liveId: "b",
        name: "Finder: Sidecar",
        startedAt: 2_000,
        toolUseCount: 13,
        usageTokens: 130_800,
      }),
      liveEntry({
        liveId: "a",
        name: "Finder: Rust",
        startedAt: 1_000,
        toolUseCount: 1,
        approxChars: 4_000,
        tools: [{ name: "grep", status: "running" }],
      }),
      liveEntry({ liveId: "settled", status: "done" }),
    ])
    expect(rows.map((r) => r.liveId)).toEqual(["a", "b"])
    expect(rows[0].name).toBe("Finder: Rust")
    expect(rows[0].depth).toBe(0)
    expect(rows[0].stats).toBe("1 tool use · 1.0k tokens")
    expect(rows[0].activity).toBe("Searching for 1 pattern…")
    expect(rows[1].stats).toBe("13 tool uses · 130.8k tokens")
  })

  it("nests children depth-first under their parent with bumped depth", () => {
    const rows = buildLiveAgentTreeRows([
      // Deliberately unordered input; grandchild → child → other root → root.
      liveEntry({ liveId: "grand", parentLiveId: "child", startedAt: 4_000 }),
      liveEntry({ liveId: "child", parentLiveId: "root", startedAt: 3_000 }),
      liveEntry({ liveId: "other", startedAt: 2_000 }),
      liveEntry({ liveId: "root", startedAt: 1_000 }),
    ])
    expect(rows.map((r) => `${r.liveId}:${r.depth}`)).toEqual([
      "root:0",
      "child:1",
      "grand:2",
      "other:0",
    ])
  })

  it("re-roots a running child whose parent is not running", () => {
    const rows = buildLiveAgentTreeRows([
      liveEntry({ liveId: "orphan", parentLiveId: "settled-parent", startedAt: 2_000 }),
      liveEntry({ liveId: "settled-parent", status: "done", startedAt: 1_000 }),
    ])
    expect(rows.map((r) => `${r.liveId}:${r.depth}`)).toEqual(["orphan:0"])
  })

  it("surfaces mutually-parented entries flat instead of dropping them", () => {
    const rows = buildLiveAgentTreeRows([
      liveEntry({ liveId: "x", parentLiveId: "y", startedAt: 1_000 }),
      liveEntry({ liveId: "y", parentLiveId: "x", startedAt: 2_000 }),
    ])
    expect(rows.map((r) => r.liveId).sort()).toEqual(["x", "y"])
  })
})

describe("orderRowsHierarchically", () => {
  const row = (over: Partial<AgentPanelRow>): AgentPanelRow => ({
    id: `live:${over.liveId ?? "r"}`,
    kind: "inflight",
    name: "n",
    task: "t",
    status: "running",
    ...over,
  })

  it("seats children directly under their parent and stamps depth", () => {
    const ordered = orderRowsHierarchically([
      row({ liveId: "child", parentLiveId: "root" }),
      row({ liveId: "root" }),
      row({ liveId: "other" }),
    ])
    expect(ordered.map((r) => `${r.liveId}:${r.depth ?? 0}`)).toEqual([
      "root:0",
      "child:1",
      "other:0",
    ])
  })

  it("keeps rows without a present parent (and non-live rows) in place at depth 0", () => {
    const journalRow: AgentPanelRow = {
      id: "bg:j1",
      kind: "background",
      name: "j",
      task: "t",
      status: "done",
    }
    const ordered = orderRowsHierarchically([
      row({ liveId: "lost-child", parentLiveId: "gone" }),
      journalRow,
    ])
    expect(ordered.map((r) => r.id)).toEqual(["live:lost-child", "bg:j1"])
    expect(ordered[0].depth ?? 0).toBe(0)
  })

  it("appends cycle remnants flat instead of looping or dropping them", () => {
    const ordered = orderRowsHierarchically([
      row({ liveId: "x", parentLiveId: "y" }),
      row({ liveId: "y", parentLiveId: "x" }),
    ])
    expect(ordered.map((r) => r.liveId).sort()).toEqual(["x", "y"])
  })
})

describe("agentRowBadge", () => {
  it("maps each status to a glyph + theme token", () => {
    expect(agentRowBadge("running")).toEqual({ glyph: "◆", token: "accent" })
    expect(agentRowBadge("done")).toEqual({ glyph: "●", token: "success" })
    expect(agentRowBadge("error")).toEqual({ glyph: "✗", token: "danger" })
    expect(agentRowBadge("interrupted")).toEqual({ glyph: "!", token: "warning" })
  })
})

describe("formatElapsed", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatElapsed(12_000)).toBe("12s")
    expect(formatElapsed(184_000)).toBe("3m 4s")
    expect(formatElapsed(3_720_000)).toBe("1h 2m")
    expect(formatElapsed(-5)).toBe("0s")
  })
})

describe("agentRowHint", () => {
  it("labels the source and appends elapsed when startedAt is known", () => {
    expect(
      agentRowHint(
        { id: "x", kind: "background", name: "n", task: "", status: "running", startedAt: 1_000 },
        13_000
      )
    ).toBe("background · 12s")
    expect(
      agentRowHint({ id: "y", kind: "inflight", name: "n", task: "", status: "running" }, 13_000)
    ).toBe("in-turn")
  })

  it("appends tool-use and token stats when present", () => {
    expect(
      agentRowHint(
        {
          id: "x",
          kind: "inflight",
          name: "n",
          task: "",
          status: "running",
          startedAt: 1_000,
          toolUses: 10,
          tokens: 115_040,
        },
        156_000
      )
    ).toBe("in-turn · 2m 35s · 10 tools · ↓ 115.0k tok")
    // Zero stats stay hidden (a run that has not called tools yet).
    expect(
      agentRowHint(
        {
          id: "y",
          kind: "inflight",
          name: "n",
          task: "",
          status: "running",
          toolUses: 0,
          tokens: 0,
        },
        0
      )
    ).toBe("in-turn")
  })
})

describe("agentSummary", () => {
  it("counts total / running / settled", () => {
    const rows = buildAgentPanelRows(
      sources({
        inflight: [{ callKey: "k", name: "n", task: "" }],
        journalRecords: [journal({ runId: "d", status: "done" })],
      })
    )
    expect(agentSummary(rows)).toEqual({ total: 2, running: 1, settled: 1 })
  })
})

describe("agentRowTask", () => {
  const base: AgentPanelRow = {
    id: "bg:1",
    kind: "background",
    name: "planner",
    task: "",
    status: "running",
    startedAt: 0,
  }
  const width = (row: AgentPanelRow, columns: number) =>
    stringWidth(
      `  \u25c6 ${row.name} \u00b7 ${agentRowHint(row, 60_000)} \u00b7 ${agentRowTask(row, 60_000, columns)}`
    )

  it("cuts an ASCII task to the columns the row has left", () => {
    const row = { ...base, task: "x".repeat(200) }
    // The row plus the panel border and padding must not exceed the terminal.
    expect(width(row, 80)).toBeLessThanOrEqual(80 - 4)
  })

  it("cuts a CJK task by display columns, not characters", () => {
    // 40 wide glyphs are 80 columns: a character budget would let every one of
    // them through and the row would wrap onto a second terminal row.
    const row = { ...base, task: "\u91cd\u6784".repeat(20) }
    expect(width(row, 80)).toBeLessThanOrEqual(80 - 4)
    expect(agentRowTask(row, 60_000, 80)).toContain("\u2026")
  })

  it("leaves a task that already fits alone", () => {
    const row = { ...base, task: "short task" }
    expect(agentRowTask(row, 60_000, 120)).toBe("short task")
  })

  it("collapses whitespace so a multi-line prompt stays one row", () => {
    const row = { ...base, task: "  first line\n\n  second line  " }
    expect(agentRowTask(row, 60_000, 120)).toBe("first line second line")
  })

  it("drops the task entirely when the row has no room worth spending", () => {
    const row = { ...base, task: "some task text" }
    expect(agentRowTask(row, 60_000, 30)).toBe("")
  })

  it("charges the nesting indent, so a child row cuts earlier than its parent", () => {
    const row = { ...base, task: "y".repeat(200) }
    const parent = agentRowTask(row, 60_000, 80)
    const child = agentRowTask({ ...row, depth: 2 }, 60_000, 80)
    expect(stringWidth(child)).toBeLessThan(stringWidth(parent))
  })

  it("is empty for a row with no task", () => {
    expect(agentRowTask(base, 60_000, 80)).toBe("")
  })
})
