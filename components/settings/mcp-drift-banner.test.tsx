/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { McpDriftBanner } from "./mcp-drift-banner"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/claude/sync", () => ({ syncToAgent: jest.fn() }))
jest.mock("@/hooks/agent", () => ({
  useAgentStatuses: () => ({
    statuses: [
      {
        agent: { id: "claude-code", displayName: "Claude Code", writable: true },
        exists: true,
        parseError: null,
      },
    ],
    drift: { "claude-code": { missing: ["server-a"], unmanaged: [] } },
    refresh: jest.fn(),
  }),
}))

it("expands drift details through the shared Button primitive", () => {
  render(<McpDriftBanner />)

  const trigger = screen.getByRole("button", { name: "Claude Code" })
  expect(trigger).toHaveAttribute("data-slot", "button")
  fireEvent.click(trigger)
  expect(screen.getByText("server-a")).toBeInTheDocument()
})
