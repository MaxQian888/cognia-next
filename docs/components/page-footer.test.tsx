import { render, screen } from "@testing-library/react"
import { buildFeedbackHref, PageFooter } from "./page-footer"

describe("PageFooter", () => {
  it("builds a prefilled GitHub issue for page feedback", () => {
    const href = buildFeedbackHref(["en", "getting-started"], false)
    expect(href).toContain("/issues/new?")
    expect(decodeURIComponent(href)).toContain("Needs improvement: en/getting-started")
  })

  it("shows last-modified metadata only when supplied", () => {
    const { rerender } = render(
      <PageFooter slug={["en", "getting-started"]} lastModified="2026-07-22T10:00:00Z" />
    )
    expect(screen.getByText(/Last updated:/)).toBeInTheDocument()

    rerender(<PageFooter slug={["en", "getting-started"]} lastModified={null} />)
    expect(screen.queryByText(/Last updated:/)).not.toBeInTheDocument()
  })

  it("links feedback to a prefilled issue in a new tab", () => {
    render(<PageFooter slug={["en", "getting-started"]} />)

    expect(screen.getByRole("link", { name: "Not helpful" })).toMatchObject({
      target: "_blank",
      rel: "noopener noreferrer",
    })
    expect(screen.getByRole("link", { name: "Not helpful" })).toHaveAttribute(
      "href",
      expect.stringContaining("/issues/new?")
    )
  })
})
