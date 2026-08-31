/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { McpAgentStatusBar } from "./mcp-agent-status-bar"
import type { SurfaceReach } from "@/lib/platform/surface-reach"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

let reachMock: SurfaceReach = { available: true }
jest.mock("@/hooks/platform/use-surface-reach", () => ({
  useSurfaceReach: () => reachMock,
}))

const statusesMock = {
  statuses: [
    {
      agent: { id: "claude-code", writable: true, label: "Claude Code" },
      exists: true,
      count: 2,
    },
  ],
  projectedCount: { "claude-code": 2 },
  refresh: jest.fn(),
  loading: false,
  drift: {},
}
jest.mock("@/hooks/agent", () => ({
  useAgentStatuses: () => statusesMock,
}))

jest.mock("@/lib/claude/sync", () => ({
  syncToAgent: jest.fn(async () => ({ ok: true, count: 0 })),
}))

beforeEach(() => {
  reachMock = { available: true }
})

describe("<McpAgentStatusBar />", () => {
  it("renders the agent list when the surface can run", () => {
    render(<McpAgentStatusBar />)
    expect(screen.queryByTestId("mcp-agents-unavailable")).not.toBeInTheDocument()
    expect(screen.getByTestId("mcp-agent-status-bar")).toBeInTheDocument()
  })

  it("explains itself instead of vanishing when it cannot run", () => {
    // This bar IS the Agents tab. `return null` left that tab holding nothing
    // but a related-links strip, with no hint that agent sync exists.
    reachMock = { available: false, block: "needs-desktop-shell", remedy: null }
    render(<McpAgentStatusBar />)
    const notice = screen.getByTestId("mcp-agents-unavailable")
    expect(notice).toHaveAttribute("data-cause", "needs-desktop-shell")
    expect(screen.queryByTestId("mcp-agent-status-bar")).not.toBeInTheDocument()
  })

  it("names the cause a standalone browser gets, which is a different one", () => {
    reachMock = { available: false, block: "no-host", remedy: "/pair" }
    render(<McpAgentStatusBar />)
    expect(screen.getByTestId("mcp-agents-unavailable")).toHaveAttribute("data-cause", "no-host")
  })
})
