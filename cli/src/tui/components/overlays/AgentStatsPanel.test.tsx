import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { AgentStatsPanel } from "./AgentStatsPanel"
import type { AgentStatsOverview, ConvStatRow } from "../../runtime/agent-stats-model"

const overview: AgentStatsOverview = {
  conversations: 2,
  messages: 5,
  toolCalls: 3,
  tokens: 12000,
  costUsd: 0.5,
  firstAt: 1000,
  lastAt: 2000,
  bySource: [
    { source: "claude-code", conversations: 1, messages: 3, tokens: 8000, costUsd: 0.3 },
    { source: "codex", conversations: 1, messages: 2, tokens: 4000, costUsd: 0.2 },
  ],
  byModel: [
    {
      model: "opus",
      turns: 2,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.5,
    },
  ],
  tokensPerDay: [
    { date: "2025-01-01", tokens: 100, cost: 0.1, requests: 1 },
    { date: "2025-01-02", tokens: 200, cost: 0.2, requests: 1 },
  ],
  convsPerDay: [
    { date: "2025-01-01", count: 1 },
    { date: "2025-01-02", count: 1 },
  ],
  topTools: [
    { name: "Bash", count: 2 },
    { name: "Edit", count: 1 },
  ],
  notes: ["Analyzed the 2 most recent of 9 conversations."],
}

const rows: ConvStatRow[] = [
  {
    id: "import:claude-code:a",
    source: "claude-code",
    title: "First convo",
    messageCount: 3,
    toolCalls: 2,
    tokens: 8000,
    costUsd: 0.3,
    updatedAt: 2000,
  },
  {
    id: "import:codex:b",
    source: "codex",
    title: "Second convo",
    messageCount: 2,
    toolCalls: 1,
    tokens: 4000,
    costUsd: 0.2,
    updatedAt: 1000,
  },
]

function wrap(props: Partial<React.ComponentProps<typeof AgentStatsPanel>> = {}) {
  const cb = { onView: jest.fn(), onCancel: jest.fn() }
  const result = render(<AgentStatsPanel overview={overview} rows={rows} {...cb} {...props} />)
  return { ...result, ...cb }
}

describe("AgentStatsPanel", () => {
  beforeEach(() => __resetInk())

  it("renders KPIs, sources, tools, notes, and the conversation list", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("Agent Stats")
    expect(text).toContain("2")
    expect(text).toContain("convs")
    expect(text).toContain("By source")
    expect(text).toContain("claude-code")
    expect(text).toContain("Top tools")
    expect(text).toContain("Bash")
    expect(text).toContain("Analyzed the 2 most recent")
    expect(text).toContain("First convo")
    expect(text).toContain("Second convo")
    expect(text).toContain("CC")
  })

  it("renders an empty list state", () => {
    const text = wrap({ rows: [] }).container.textContent ?? ""
    expect(text).toContain("none")
  })

  it("Enter drills into the highlighted conversation", () => {
    const { onView } = wrap()
    act(() => __fireInput("", { return: true }))
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: "import:claude-code:a" }))
  })

  it("down then Enter selects the next conversation", () => {
    const { onView } = wrap()
    act(() => __fireInput("", { downArrow: true }))
    act(() => __fireInput("", { return: true }))
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: "import:codex:b" }))
  })

  it("Esc closes", () => {
    const { onCancel } = wrap()
    act(() => __fireInput("", { escape: true }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("renders opencode/plugin tags and hides empty sections + zero stats", () => {
    const emptyOverview: AgentStatsOverview = {
      ...overview,
      bySource: [],
      byModel: [],
      convsPerDay: [],
      tokensPerDay: [],
      topTools: [],
      notes: [],
    }
    const zeroRows: ConvStatRow[] = [
      {
        id: "import:opencode:x",
        source: "opencode",
        title: "OC one",
        messageCount: 1,
        toolCalls: 0,
        tokens: 0,
        costUsd: 0,
        updatedAt: 1,
      },
      {
        id: "myplugin:sess:y",
        source: "myplugin:sess",
        title: "Plugin one",
        messageCount: 1,
        toolCalls: 0,
        tokens: 0,
        costUsd: 0,
        updatedAt: 0,
      },
    ]
    const text = wrap({ overview: emptyOverview, rows: zeroRows }).container.textContent ?? ""
    expect(text).toContain("OC")
    expect(text).toContain("MY")
    expect(text).not.toContain("By source")
    expect(text).not.toContain("Top tools")
  })
})
