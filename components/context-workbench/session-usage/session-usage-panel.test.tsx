/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { analyzeSession } from "@/lib/analysis/session-report"
import { buildSdkContextBreakdown, resolveAutoCompaction } from "@/lib/claude/context-breakdown"
import { resolveContextWindowUsage } from "@/lib/claude/usage"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { SessionContextWindow } from "@/hooks/chat/use-session-context-window"
import { SessionUsagePanel, SessionUsagePanelView } from "./session-usage-panel"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))
jest.mock("@/components/chat/context-usage-indicator", () => ({
  ContextWindowHeader: ({ used, max }: { used: number; max: number }) => (
    <div data-testid="window-header" data-used={used} data-max={max} />
  ),
  CompactNowButton: ({ supported }: { supported: boolean }) => (
    <button data-testid="compact-now" disabled={!supported} />
  ),
}))
jest.mock("@/components/chat/session-insights/session-insights-sheet", () => ({
  SessionInsightsSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="insights-sheet" /> : null,
}))

const reportState: { value: ReturnType<typeof analyzeSession> | null; loading: boolean } = {
  value: null,
  loading: false,
}
jest.mock("@/hooks/analysis/use-session-report", () => ({
  useSessionReport: () => ({ report: reportState.value, loading: reportState.loading }),
}))
const rankMock = jest.fn((..._args: unknown[]) => null as unknown)
jest.mock("@/hooks/usage/use-session-cost-rank", () => ({
  useSessionCostRank: (...args: unknown[]) => rankMock(...args),
}))
const refresh = jest.fn()
jest.mock("@/hooks/chat/use-session-context-window", () => ({
  useSessionContextWindow: () => context(),
}))
const jumpMock = jest.fn(() => true)
jest.mock("@/stores/chat/chat-viewport-store", () => ({
  useChatViewportStore: (selector: (s: unknown) => unknown) =>
    selector({ jumpToMessage: jumpMock }),
}))

const resolve = () => ({ promptPer1M: 3, completionPer1M: 15 })

function row(i: number, over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `a${i}`,
    sessionId: "s1",
    at: 1_000 * i,
    model: "claude-sonnet",
    inputTokens: 2_000,
    outputTokens: 400,
    cacheCreationTokens: 0,
    cacheReadTokens: 10_000 * i,
    contextInputTokens: 12_000 * i,
    costUsd: 0,
    durationMs: 4_000,
    ...over,
  }
}

function report(rows: SessionUsageRow[]) {
  const messages = [
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "tool-Bash", state: "output-available", input: { command: "ls" } },
        { type: "tool-Read", state: "output-error", input: { file_path: "x" } },
      ],
    },
  ]
  return analyzeSession({ messages: messages as never, usageRows: rows }, { resolve })
}

function context(): SessionContextWindow {
  const snapshot = {
    totalTokens: 48_000,
    maxTokens: 200_000,
    percentage: 24,
    categories: [
      { name: "Messages", tokens: 30_000 },
      { name: "System tools", tokens: 12_000 },
      { name: "System prompt", tokens: 6_000 },
      { name: "Free space", tokens: 152_000 },
    ],
  }
  const win = resolveContextWindowUsage(snapshot, null, "m")
  return {
    win,
    breakdown: buildSdkContextBreakdown(snapshot),
    compaction: resolveAutoCompaction(snapshot, { occupancyReported: true, agentOwned: false }),
    agentOwned: false,
    assistantTurns: 3,
    refresh,
  }
}

beforeEach(() => {
  reportState.value = null
  reportState.loading = false
  jumpMock.mockClear()
  rankMock.mockClear()
})

describe("SessionUsagePanelView", () => {
  it("draws every section for a conversation with billed turns", () => {
    render(
      <SessionUsagePanelView
        sessionId="s1"
        report={report([row(1), row(2), row(3, { model: "claude-opus" })])}
        loading={false}
        context={context()}
        rank={{ percentile: 72, peers: 10, medianUsd: 0.05 }}
      />
    )
    expect(screen.getByTestId("session-usage-kpis")).toHaveTextContent("Turns3")
    expect(screen.getByTestId("window-header")).toHaveAttribute("data-used", "48000")
    expect(screen.getByTestId("context-composition-center")).toHaveTextContent("24%")
    expect(screen.getByTestId("context-growth")).toBeInTheDocument()
    expect(screen.getByTestId("session-cost-timeline")).toBeInTheDocument()
    expect(screen.getByTestId("session-cost-rank")).toHaveTextContent("72%")
    expect(screen.getByTestId("token-mix")).toBeInTheDocument()
    expect(screen.getByTestId("tool-calls-row-Bash")).toBeInTheDocument()
    expect(screen.getByTestId("tool-calls-errors")).toHaveTextContent("1 failed")
    expect(screen.getByTestId("session-usage-models")).toBeInTheDocument()
    expect(screen.getByTestId("session-usage-efficiency")).toBeInTheDocument()
  })

  it("hides the model mix for a single-model conversation", () => {
    render(
      <SessionUsagePanelView
        sessionId="s1"
        report={report([row(1)])}
        loading={false}
        context={context()}
        rank={null}
      />
    )
    expect(screen.queryByTestId("session-usage-models")).toBeNull()
  })

  it("keeps the window section while the history loads or is empty", () => {
    const { rerender } = render(
      <SessionUsagePanelView sessionId="s1" report={null} loading context={context()} rank={null} />
    )
    expect(screen.getByTestId("session-usage-loading")).toBeInTheDocument()
    expect(screen.getByTestId("session-usage-window")).toBeInTheDocument()
    rerender(
      <SessionUsagePanelView
        sessionId="s1"
        report={report([])}
        loading={false}
        context={context()}
        rank={null}
      />
    )
    expect(screen.getByTestId("session-usage-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("session-usage-kpis")).toBeNull()
  })

  it("refreshes the live reading on request", () => {
    render(
      <SessionUsagePanelView
        sessionId="s1"
        report={null}
        loading={false}
        context={context()}
        rank={null}
      />
    )
    fireEvent.click(screen.getByTestId("session-usage-refresh"))
    expect(refresh).toHaveBeenCalled()
  })
})

describe("SessionUsagePanel", () => {
  const session = { id: "s1", title: "Refactor", model: "claude-sonnet" }

  it("ranks the conversation on its whole report and jumps within the mounted list", () => {
    reportState.value = report([row(1, { costUsd: 0.5, costSource: "sdk", costKnown: true })])
    render(<SessionUsagePanel session={session} messages={[]} />)
    expect(rankMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "s1", turns: 1, costUsd: 0.5 }),
      expect.any(Number)
    )
    fireEvent.click(screen.getByTestId("session-cost-jump-1"))
    expect(jumpMock).toHaveBeenCalledWith("a1", undefined, { align: "center" })
  })

  it("opens the health report sheet", () => {
    reportState.value = report([row(1)])
    render(<SessionUsagePanel session={session} messages={[]} />)
    expect(screen.queryByTestId("insights-sheet")).toBeNull()
    fireEvent.click(screen.getByTestId("session-usage-open-report"))
    expect(screen.getByTestId("insights-sheet")).toBeInTheDocument()
  })
})
