import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { TrustPage } from "./trust-page"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

describe("TrustPage", () => {
  it("carries the page heading and both sections", () => {
    render(<TrustPage locale="en" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.trust.header.title })
    ).toBeInTheDocument()
    for (const section of en.trust.sections) {
      expect(screen.getByRole("heading", { name: section.title })).toBeInTheDocument()
    }
  })

  it("renders the claim-and-source table as a real table", () => {
    render(<TrustPage locale="en" />)
    const table = screen.getByRole("table")
    expect(within(table).getAllByRole("row")).toHaveLength(en.trust.evidence.rows.length + 1)
  })

  it("gives every claim a source that resolves somewhere", () => {
    render(<TrustPage locale="en" />)
    const table = screen.getByRole("table")
    for (const row of en.trust.evidence.rows) {
      const tableRow = within(table).getByRole("row", { name: new RegExp(escape(row.claim)) })
      const link = within(tableRow).getByRole("link")
      expect(link.getAttribute("href")).toBeTruthy()
    }
  })

  it("cites the license file itself, not a restatement of it", () => {
    render(<TrustPage locale="en" />)
    expect(screen.getByRole("link", { name: "LICENSE in the repository" })).toHaveAttribute(
      "href",
      "https://github.com/MaxQian888/cognia-next/blob/master/LICENSE"
    )
  })

  it("sends docs-backed claims to the documentation site", () => {
    render(<TrustPage locale="en" />)
    const adrRow = en.trust.evidence.rows.find((row) => row.docsPath)
    expect(adrRow).toBeTruthy()
    const link = screen.getByRole("link", { name: adrRow!.source })
    expect(link.getAttribute("href")).toContain(adrRow!.docsPath)
  })

  it("localises", () => {
    render(<TrustPage locale="zh" />)
    expect(screen.getByRole("heading", { name: zh.trust.evidence.title })).toBeInTheDocument()
  })
})

/** Escape a claim string for use inside an accessible-name RegExp. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
