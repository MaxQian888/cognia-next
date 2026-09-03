/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { FidelitySummary, type FidelitySummaryEntry } from "./fidelity-summary"

const entries = (count: number): FidelitySummaryEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    label: "Dropped",
    path: `path/${index}`,
  }))

describe("FidelitySummary", () => {
  it("renders the title, badges and hints", () => {
    render(
      <FidelitySummary
        title="Conversion"
        badges={[
          { id: "a", label: "Structured", variant: "secondary", testId: "badge-a" },
          { id: "b", label: "Reconstructed", variant: "outline" },
        ]}
        hints={["Most things carried over.", "Some did not."]}
        entries={[]}
        emptyLabel="Nothing was lost."
      />
    )
    expect(screen.getByText("Conversion")).toBeInTheDocument()
    expect(screen.getByTestId("badge-a")).toHaveTextContent("Structured")
    expect(screen.getByText("Reconstructed")).toBeInTheDocument()
    expect(screen.getByText("Most things carried over.")).toBeInTheDocument()
    expect(screen.getByText("Some did not.")).toBeInTheDocument()
  })

  it("shows the empty label instead of an empty list", () => {
    render(<FidelitySummary title="t" entries={[]} emptyLabel="Nothing was lost." />)
    expect(screen.getByText("Nothing was lost.")).toBeInTheDocument()
    expect(screen.queryByRole("list")).toBeNull()
  })

  it("renders every entry with its path and detail", () => {
    render(
      <FidelitySummary
        title="t"
        emptyLabel="none"
        countLabel="2 items"
        entries={[
          { id: "1", path: "a/b", label: "Dropped", detail: "runtime-private" },
          { id: "2", label: "Summarized" },
        ]}
      />
    )
    expect(screen.getByText("2 items")).toBeInTheDocument()
    expect(screen.getByText("a/b")).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Dropped: runtime-private")
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("Summarized")
  })

  it("shows every entry when no cap is given", () => {
    // Session import's existing behaviour. Capping by default would have been a
    // behaviour change wearing a refactor's clothes.
    render(<FidelitySummary title="t" emptyLabel="none" entries={entries(30)} />)
    expect(screen.getAllByRole("listitem")).toHaveLength(30)
    expect(screen.queryByTestId("fidelity-summary-more")).toBeNull()
  })

  it("caps the list and reports the remainder when asked", () => {
    render(
      <FidelitySummary
        title="t"
        emptyLabel="none"
        entries={entries(12)}
        maxEntries={5}
        moreLabel={(hidden) => `and ${hidden} more`}
      />
    )
    expect(screen.getAllByRole("listitem")).toHaveLength(5)
    expect(screen.getByTestId("fidelity-summary-more")).toHaveTextContent("and 7 more")
  })

  it("stays silent about a remainder when the cap is not reached", () => {
    render(
      <FidelitySummary
        title="t"
        emptyLabel="none"
        entries={entries(3)}
        maxEntries={5}
        moreLabel={(hidden) => `and ${hidden} more`}
      />
    )
    expect(screen.queryByTestId("fidelity-summary-more")).toBeNull()
  })

  it("keeps long unbreakable paths breakable", () => {
    // It renders inside a max-w-sm chat tooltip. A 36-character id that cannot
    // break forces the whole tooltip wider than the viewport.
    render(
      <FidelitySummary
        title="t"
        emptyLabel="none"
        entries={[{ id: "1", path: "0e6f8b1a-1c2d-4e3f-9a8b-7c6d5e4f3a2b", label: "Dropped" }]}
      />
    )
    expect(screen.getByText("0e6f8b1a-1c2d-4e3f-9a8b-7c6d5e4f3a2b")).toHaveClass("break-all")
  })

  it("adds no card, background or fixed width of its own", () => {
    // The tooltip and the dialog supply their own chrome. A background here
    // would paint a panel inside both.
    const { container } = render(
      <FidelitySummary title="t" emptyLabel="none" entries={[]} testId="probe" />
    )
    const root = screen.getByTestId("probe")
    expect(root.className).not.toMatch(/\bbg-|\brounded-|\bborder\b|\bw-\[|\bmax-w-/)
    expect(container.querySelector("[data-slot=card]")).toBeNull()
  })
})
