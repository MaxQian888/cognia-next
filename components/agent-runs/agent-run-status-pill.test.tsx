import { render, screen } from "@testing-library/react"
import { ExecutionStatusPill } from "./agent-run-status-pill"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => `status.${k}`,
}))

describe("ExecutionStatusPill", () => {
  it("renders the localized status label", () => {
    render(<ExecutionStatusPill status="running" />)
    expect(screen.getByText("status.running")).toBeInTheDocument()
  })

  it("applies a status-specific class and merges className", () => {
    const { container } = render(<ExecutionStatusPill status="error" className="extra" />)
    const span = container.querySelector("span")!
    expect(span.className).toContain("extra")
    expect(span.className).toMatch(/red/)
  })

  /** `queued` had no place in the old four-status union — it rendered as running. */
  it("distinguishes queued from running", () => {
    const { container: queued } = render(<ExecutionStatusPill status="queued" />)
    const { container: running } = render(<ExecutionStatusPill status="running" />)
    expect(queued.querySelector("span")!.className).not.toBe(
      running.querySelector("span")!.className
    )
  })

  /** A run the user stopped is not a failure, and must not be painted like one. */
  it("does not colour a cancelled run like an error", () => {
    const { container } = render(<ExecutionStatusPill status="cancelled" />)
    expect(container.querySelector("span")!.className).not.toMatch(/red/)
  })
})
