import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"
import type { UIMessage } from "ai"

import { AgentStatsDetailPanel } from "./AgentStatsDetailPanel"
import { analyzeSession } from "@/lib/analysis/session-report"

const report = analyzeSession({
  messages: [
    { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] },
    {
      id: "a",
      role: "assistant",
      parts: [{ type: "tool-Bash", state: "output-error", input: { command: "ls" } }],
    },
  ] as unknown as UIMessage[],
  usageRows: [
    {
      messageId: "a",
      sessionId: "s",
      at: 1000,
      model: "opus",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 200,
      costUsd: 0.02,
      durationMs: 0,
    },
  ],
  sessionMeta: { title: "Fix bug" },
})

describe("AgentStatsDetailPanel", () => {
  beforeEach(() => __resetInk())

  it("renders the report's KPIs, breakdowns, signals, and assessments", () => {
    const { container } = render(
      <AgentStatsDetailPanel report={report} title="Fix bug" onClose={() => {}} viewportRows={60} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Fix bug")
    expect(text).toContain("turns")
    expect(text).toContain("Tokens")
    expect(text).toContain("By model")
    expect(text).toContain("opus")
    expect(text).toContain("Top tools")
    expect(text).toContain("Bash")
    expect(text).toContain("Signals")
    expect(text).toContain("Health")
    expect(text).toContain("Tool health")
    expect(text).toContain("Context pressure")
  })

  it("closes on Escape", () => {
    const onClose = jest.fn()
    render(<AgentStatsDetailPanel report={report} title="t" onClose={onClose} viewportRows={60} />)
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })

  it("closes on Enter", () => {
    const onClose = jest.fn()
    render(<AgentStatsDetailPanel report={report} title="t" onClose={onClose} viewportRows={60} />)
    __fireInput("", { return: true })
    expect(onClose).toHaveBeenCalled()
  })

  it("renders commit stats and the no-cache-writes detail", () => {
    const committed = analyzeSession({
      messages: [
        {
          id: "a",
          role: "assistant",
          parts: [
            {
              type: "tool-Bash",
              state: "output-available",
              input: { command: "git commit -m x" },
              output: "ok",
            },
          ],
        },
      ] as unknown as UIMessage[],
      usageRows: [
        {
          messageId: "a",
          sessionId: "s",
          at: 1000,
          model: "opus",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.5,
          durationMs: 0,
        },
      ],
    })
    const { container } = render(
      <AgentStatsDetailPanel
        report={committed}
        title="Committed"
        onClose={() => {}}
        viewportRows={60}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("commits")
    expect(text).toContain("no cache writes")
    expect(text).toContain("/commit")
  })
})

describe("title row", () => {
  beforeEach(() => __resetInk())

  it("cuts a long title to one row, measured in display columns", () => {
    // The title sits above the scrolling viewport, whose height is budgeted
    // assuming this header is exactly one row. A CJK title is the case a
    // character budget gets wrong: 40 glyphs are 80 columns, not 40.
    const cjk = "重构会话渲染管线".repeat(5)
    const { container } = render(
      <AgentStatsDetailPanel
        report={report}
        title={cjk}
        width={80}
        viewportRows={60}
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("…")
    expect(text).not.toContain(cjk)
  })

  it("falls back to a placeholder when the conversation has no title", () => {
    const { container } = render(
      <AgentStatsDetailPanel
        report={report}
        title="   "
        width={80}
        viewportRows={60}
        onClose={() => {}}
      />
    )
    expect(container.textContent ?? "").toContain("Conversation")
  })
})
