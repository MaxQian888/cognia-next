import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { RunMatrix } from "./run-matrix"

const DOCS = "https://docs.cognia.example"

function renderMatrix(locale: "en" | "zh" = "en") {
  const copy = locale === "en" ? en : zh
  return render(
    <RunMatrix
      copy={copy.home.run}
      learnMore={copy.common.learnMore}
      locale={locale}
      docsOrigin={DOCS}
    />
  )
}

describe("RunMatrix", () => {
  it("renders the heading and the boundary question", () => {
    renderMatrix()
    expect(screen.getByRole("heading", { name: en.home.run.title })).toBeInTheDocument()
    expect(screen.getByText(en.home.run.subtitle)).toBeInTheDocument()
  })

  it("uses a real table so row and column relationships survive a screen reader", () => {
    renderMatrix()
    const table = screen.getByRole("table")
    // Header, one row per strategy, and the shared confirmation row.
    expect(within(table).getAllByRole("row")).toHaveLength(en.home.run.strategies.length + 2)
  })

  it("asks the four questions the spec requires of every strategy", () => {
    renderMatrix()
    const table = screen.getByRole("table")
    for (const heading of [
      en.home.run.headings.leaves,
      en.home.run.headings.receives,
      en.home.run.headings.tools,
    ]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument()
    }
    // The fourth is answered once, for every strategy, in the footer row.
    expect(
      within(table).getByRole("rowheader", { name: en.home.run.headings.approval })
    ).toBeInTheDocument()
  })

  it("states what needs confirmation once rather than once per strategy", () => {
    renderMatrix()
    const table = screen.getByRole("table")
    const cell = within(table).getByText(en.home.run.approvalShared)
    expect(cell).toHaveAttribute("colspan", "3")
    expect(screen.getAllByText(en.home.run.approvalShared)).toHaveLength(2) // table + stacked
  })

  it("answers the per-strategy three for every strategy", () => {
    renderMatrix()
    const table = screen.getByRole("table")
    for (const strategy of en.home.run.strategies) {
      const row = within(table).getByRole("row", { name: new RegExp(strategy.name) })
      for (const answer of [strategy.leaves, strategy.receives, strategy.tools]) {
        expect(within(row).getByText(answer)).toBeInTheDocument()
      }
    }
  })

  it("links every strategy to versioned documentation", () => {
    renderMatrix()
    for (const strategy of en.home.run.strategies) {
      expect(
        screen
          .getAllByRole("link", { name: en.common.learnMore })
          .some((link) => link.getAttribute("href")?.endsWith(strategy.docsPath))
      ).toBe(true)
    }
  })

  it("shows no provider logo wall — the matrix is the content", () => {
    const { container } = renderMatrix()
    expect(container.querySelectorAll("img")).toHaveLength(0)
  })

  it("repeats the column names as labels in the stacked layout", () => {
    renderMatrix()
    // Rendered twice: once as a column header, once as a stacked term.
    expect(screen.getAllByText(en.home.run.headings.leaves).length).toBeGreaterThan(1)
  })

  it("localises the matrix", () => {
    renderMatrix("zh")
    expect(screen.getByRole("heading", { name: zh.home.run.title })).toBeInTheDocument()
    expect(
      within(screen.getByRole("table")).getByRole("columnheader", {
        name: zh.home.run.headings.leaves,
      })
    ).toBeInTheDocument()
  })

  it("carries the docs locale across to the documentation site", () => {
    renderMatrix("zh")
    const link = screen.getAllByRole("link", { name: zh.common.learnMore })[0]
    expect(link.getAttribute("href")).toContain(`${DOCS}/zh/`)
  })

  it("closes on the agents the workspace can run or import", () => {
    renderMatrix()
    const list = screen.getByRole("list", { name: en.home.run.agents.label })
    expect(within(list).getAllByRole("listitem")).toHaveLength(en.home.run.agents.items.length)
  })
})
