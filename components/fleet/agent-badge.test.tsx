/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { AgentBadge } from "./agent-badge"
import { TerminalBadge } from "./terminal-badge"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `agents.${key}`,
}))

describe("AgentBadge", () => {
  it("renders a translated chip per agent", () => {
    for (const agent of ["claude-code", "codex", "opencode", "cognia"] as const) {
      const { unmount } = render(<AgentBadge agent={agent} />)
      expect(screen.getByTestId(`agent-badge-${agent}`)).toHaveTextContent(`agents.${agent}`)
      unmount()
    }
  })
})

describe("TerminalBadge", () => {
  it("renders the runtime label and app id", () => {
    render(<TerminalBadge terminal={{ app: "iterm", label: "iTerm2", sessionRef: "w0" }} />)
    const badge = screen.getByTestId("terminal-badge")
    expect(badge).toHaveTextContent("iTerm2")
    expect(badge.getAttribute("data-terminal-app")).toBe("iterm")
  })
})
