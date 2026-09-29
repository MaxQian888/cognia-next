/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ProjectUsage } from "@/hooks/project-coordinator/use-project-usage"

// next-intl is globally mocked against en.json in jest.setup.ts.

const usage: { value: ProjectUsage | undefined } = { value: undefined }
const usageArgs = jest.fn()
jest.mock("@/hooks/project-coordinator/use-project-usage", () => ({
  useProjectUsage: (...args: unknown[]) => {
    usageArgs(...args)
    return usage.value
  },
}))
jest.mock("@/components/usage/usage-budget-meters", () => ({
  UsageBudgetMeters: ({ projectId, emptyHint }: { projectId: string; emptyHint: string }) => (
    <div data-testid="meters-stub" data-project={projectId}>
      {emptyHint}
    </div>
  ),
}))
jest.mock("@/components/usage/usage-heatmap", () => ({
  UsageHeatmap: ({ rangeDays }: { rangeDays: number }) => (
    <div data-testid="heatmap-stub">{rangeDays}</div>
  ),
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { PROJECT_USAGE_RANGE_DAYS, ProjectUsagePanel } from "./project-usage-panel"

function bucket(over: Record<string, number> = {}) {
  return {
    turns: 2,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 1.25,
    durationMs: 0,
    reasoningTokens: 0,
    unpricedTurns: 0,
    ...over,
  }
}

beforeEach(() => {
  usage.value = undefined
  usageArgs.mockReset()
})

describe("ProjectUsagePanel", () => {
  it("scopes the budget meters to the workspace and explains an absent budget", () => {
    render(<ProjectUsagePanel projectId="p1" />)
    const meters = screen.getByTestId("meters-stub")
    expect(meters).toHaveAttribute("data-project", "p1")
    expect(meters).toHaveTextContent("no budget of its own")
    expect(usageArgs).toHaveBeenCalledWith("p1", PROJECT_USAGE_RANGE_DAYS, expect.any(Number))
  })

  it("shows a busy state while the rows load", () => {
    render(<ProjectUsagePanel projectId="p1" />)
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true")
  })

  it("says so when the workspace has spent nothing", () => {
    usage.value = {
      totals: { costUsd: 0, turns: 0, tokens: 0, unpricedTurns: 0 },
      daily: [],
      bySession: [],
      byModel: [],
      sessions: new Map(),
    }
    render(<ProjectUsagePanel projectId="p1" />)
    expect(screen.getByTestId("project-usage-empty")).toBeInTheDocument()
  })

  it("totals the window and breaks it down by conversation and model", () => {
    usage.value = {
      totals: { costUsd: 3.5, turns: 4, tokens: 1500, unpricedTurns: 1 },
      daily: [{ date: "2026-09-20", tokens: 1500, cost: 3.5, requests: 4 }],
      bySession: [
        {
          sessionId: "coord",
          turns: 3,
          tokens: 900,
          inputTokens: 600,
          outputTokens: 300,
          costUsd: 3,
          unpricedTurns: 0,
        },
        {
          sessionId: "gone",
          turns: 1,
          tokens: 600,
          inputTokens: 400,
          outputTokens: 200,
          costUsd: 0,
          unpricedTurns: 1,
        },
      ],
      byModel: [{ model: "claude-sonnet-5", ...bucket() }],
      sessions: new Map([
        [
          "coord",
          { id: "coord", title: "Plan the release", projectRole: "coordinator" } as ChatSession,
        ],
      ]),
    }
    render(<ProjectUsagePanel projectId="p1" />)
    expect(screen.getByTestId("project-usage-totals")).toHaveTextContent("≥ $3.50")
    expect(screen.getByTestId("project-usage-totals")).toHaveTextContent("4")
    expect(screen.getByTestId("heatmap-stub")).toHaveTextContent(String(PROJECT_USAGE_RANGE_DAYS))
    const sessions = screen.getByTestId("project-usage-sessions")
    expect(screen.getByRole("link", { name: /Plan the release/ })).toHaveTextContent("coordinator")
    expect(sessions).toHaveTextContent("Untitled conversation")
    // A session whose every turn is unpriced shows no figure rather than $0.00.
    expect(sessions).toHaveTextContent("—")
    expect(screen.getByTestId("project-usage-models")).toHaveTextContent("claude-sonnet-5")
  })
})
