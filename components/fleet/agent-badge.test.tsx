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
    for (const agent of ["claude-code", "codex", "opencode", "cognia", "devin"] as const) {
      const { unmount } = render(<AgentBadge agent={agent} />)
      expect(screen.getByTestId(`agent-badge-${agent}`)).toHaveTextContent(`agents.${agent}`)
      unmount()
    }
  })

  it("shows the configured agent name for a generic acp row", () => {
    render(<AgentBadge agent="acp" label="My Kiro" />)
    expect(screen.getByTestId("agent-badge-acp")).toHaveTextContent("My Kiro")
  })

  it("falls back to the generic product name when no label is configured", () => {
    render(<AgentBadge agent="acp" />)
    expect(screen.getByTestId("agent-badge-acp")).toHaveTextContent("agents.acp")
  })

  it("ignores a label on a dedicated agent — the i18n product name wins", () => {
    render(<AgentBadge agent="devin" label="Something Else" />)
    expect(screen.getByTestId("agent-badge-devin")).toHaveTextContent("agents.devin")
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
