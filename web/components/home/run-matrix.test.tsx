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
    expect(within(table).getAllByRole("row")).toHaveLength(en.home.run.strategies.length + 1)
  })

  it("asks the four questions the spec requires of every strategy", () => {
    renderMatrix()
    const table = screen.getByRole("table")
    for (const heading of [
      en.home.run.headings.leaves,
      en.home.run.headings.receives,
      en.home.run.headings.tools,
      en.home.run.headings.approval,
    ]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument()
    }
  })

  it("answers all four for every strategy", () => {
    renderMatrix()
    const table = screen.getByRole("table")
    for (const strategy of en.home.run.strategies) {
      const row = within(table).getByRole("row", { name: new RegExp(strategy.name) })
      for (const answer of [
        strategy.leaves,
        strategy.receives,
        strategy.tools,
        strategy.approval,
      ]) {
        // `getAllByText`: the fallback row legitimately gives the same answer
        // for tools and approval — both are unchanged by a provider switch.
        expect(within(row).getAllByText(answer).length).toBeGreaterThan(0)
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

  it("keeps the note distinguishing local, offline, self-hosted and private", () => {
    renderMatrix()
    expect(screen.getByText(en.home.run.note)).toBeInTheDocument()
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
})
