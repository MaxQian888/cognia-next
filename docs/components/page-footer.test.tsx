import { render, screen } from "@testing-library/react"
import { buildEditPath, buildFeedbackHref, PageFooter } from "./page-footer"

const SOURCE = "docs/content/docs/en/getting-started.mdx"
const SHARED_SOURCE = "docs/content/docs/plugin-dev/api-overview.mdx"

describe("buildEditPath", () => {
  it("links to the file fumadocs reported, not a reconstructed path", () => {
    expect(buildEditPath(SOURCE)).toBe(
      "https://github.com/MaxQian888/cognia-next/edit/master/docs/content/docs/en/getting-started.mdx"
    )
  })

  it("handles locale-shared pages, which have no language segment", () => {
    expect(buildEditPath(SHARED_SOURCE)).toContain(`/master/${SHARED_SOURCE}`)
  })
})

describe("PageFooter", () => {
  it("builds a prefilled GitHub issue for page feedback", () => {
    const href = buildFeedbackHref(["en", "getting-started"], SOURCE, false)
    expect(href).toContain("/issues/new?")
    expect(decodeURIComponent(href)).toContain("Needs improvement: en/getting-started")
  })

  it("points the feedback body at the real source file", () => {
    const href = buildFeedbackHref(["en", "plugin-dev", "api-overview"], SHARED_SOURCE, true)
    expect(decodeURIComponent(href)).toContain(`blob/master/${SHARED_SOURCE}`)
  })

  it("shows last-modified metadata only when supplied", () => {
    const { rerender } = render(
      <PageFooter
        slug={["en", "getting-started"]}
        sourcePath={SOURCE}
        lastModified="2026-07-22T10:00:00Z"
      />
    )
    expect(screen.getByText(/Last updated:/)).toBeInTheDocument()

    rerender(
      <PageFooter slug={["en", "getting-started"]} sourcePath={SOURCE} lastModified={null} />
    )
    expect(screen.queryByText(/Last updated:/)).not.toBeInTheDocument()
  })

  it("links the edit action at the page source", () => {
    render(<PageFooter slug={["en", "getting-started"]} sourcePath={SOURCE} />)

    expect(screen.getByRole("link", { name: /Edit this page/ })).toHaveAttribute(
      "href",
      buildEditPath(SOURCE)
    )
  })

  it("links feedback to a prefilled issue in a new tab", () => {
    render(<PageFooter slug={["en", "getting-started"]} sourcePath={SOURCE} />)

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
