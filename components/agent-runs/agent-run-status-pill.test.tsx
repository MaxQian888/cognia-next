import { render, screen } from "@testing-library/react"
import { AgentRunStatusPill } from "./agent-run-status-pill"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => `status.${k}`,
}))

describe("AgentRunStatusPill", () => {
  it("renders the localized status label", () => {
    render(<AgentRunStatusPill status="running" />)
    expect(screen.getByText("status.running")).toBeInTheDocument()
  })

  it("applies a status-specific class and merges className", () => {
    const { container } = render(<AgentRunStatusPill status="failed" className="extra" />)
    const span = container.querySelector("span")!
    expect(span.className).toContain("extra")
    expect(span.className).toMatch(/red/)
  })
})
