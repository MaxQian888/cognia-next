/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { SubagentRuntimeTab } from "./subagent-runtime-tab"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgent } from "@/types/agent/sub-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

function makeSubAgent(overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id: "sa-1",
    parentAgentId: "p1",
    name: "Researcher",
    description: "",
    task: "find sources",
    initialTask: "find sources",
    threadId: "t",
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 50,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    retryCount: 0,
    order: 0,
    ...overrides,
  }
}

beforeEach(() => {
  useSubagentRuntimeStore.setState((s) => ({ ...s, subAgents: {} }))
})

describe("SubagentRuntimeTab", () => {
  it("shows the empty state when no subagents are running", () => {
    render(<SubagentRuntimeTab />)
    expect(screen.getByTestId("subagent-runtime-empty")).toBeInTheDocument()
  })

  it("renders one row per running subagent with status, parent, and progress", () => {
    useSubagentRuntimeStore.getState().upsert(
      makeSubAgent({
        id: "sa-1",
        name: "Web Search",
        status: "running",
        progress: 40,
      })
    )
    render(<SubagentRuntimeTab />)
    const row = screen.getByTestId("subagent-runtime-row-sa-1")
    expect(row.dataset.status).toBe("running")
    expect(screen.getByText("Web Search")).toBeInTheDocument()
    // Parent label rendered via i18n key.
    expect(screen.getByText('parent:{"id":"p1"}')).toBeInTheDocument()
  })

  it("shows the latest log line when present", () => {
    useSubagentRuntimeStore.getState().upsert(
      makeSubAgent({
        logs: [
          { timestamp: new Date(), level: "info", message: "first" },
          { timestamp: new Date(), level: "warn", message: "tool failed" },
        ],
      })
    )
    render(<SubagentRuntimeTab />)
    expect(screen.getByText(/tool failed/)).toBeInTheDocument()
  })

  it("orders rows by lastActivityAt desc", () => {
    useSubagentRuntimeStore
      .getState()
      .upsert(makeSubAgent({ id: "old", lastActivityAt: new Date(2024, 0, 1) }))
    useSubagentRuntimeStore
      .getState()
      .upsert(makeSubAgent({ id: "new", lastActivityAt: new Date(2026, 4, 1) }))
    render(<SubagentRuntimeTab />)
    const rows = screen.getAllByTestId(/subagent-runtime-row-/)
    expect(rows[0]).toHaveAttribute("data-testid", "subagent-runtime-row-new")
  })

  it("renders duration when startedAt is present", () => {
    const startedAt = new Date(Date.now() - 5_000)
    useSubagentRuntimeStore
      .getState()
      .upsert(makeSubAgent({ status: "completed", startedAt, completedAt: new Date() }))
    render(<SubagentRuntimeTab />)
    // duration:{"ms": ~5000}
    expect(screen.getByText(/duration:/)).toBeInTheDocument()
  })
})
