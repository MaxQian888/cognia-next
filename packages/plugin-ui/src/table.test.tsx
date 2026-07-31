import { render, screen, within } from "@testing-library/react"

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table"

function Grid({ selected = false }: { selected?: boolean }) {
  return (
    <Table>
      <TableCaption>Recent runs</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow data-state={selected ? "selected" : undefined}>
          <TableCell>build</TableCell>
          <TableCell>passed</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>1 run</TableCell>
          <TableCell>100%</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}

describe("Table", () => {
  it("keeps native table semantics so rows and columns stay related", () => {
    render(<Grid />)

    const table = screen.getByRole("table", { name: "Recent runs" })
    // The reason this is the one component in the kit with no Radix underneath:
    // the accessibility tree comes from the element names themselves.
    expect(within(table).getAllByRole("row")).toHaveLength(3)
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
    ).toEqual(["Run", "Status"])
    expect(within(table).getByRole("cell", { name: "build" })).toBeInTheDocument()
  })

  it("names the table from its caption", () => {
    render(<Grid />)

    const caption = screen.getByText("Recent runs")
    expect(caption.tagName).toBe("CAPTION")
    expect(caption).toHaveAttribute("data-slot", "table-caption")
  })

  it("wraps the table in its own scroll container", () => {
    render(<Grid />)

    const container = screen.getByRole("table").parentElement
    expect(container).toHaveAttribute("data-slot", "table-container")
    // A plugin panel is sized by the host; an unclipped wide table would push
    // that layout instead of scrolling inside it.
    expect(container?.className).toContain("overflow-x-auto")
  })

  it("reflects selection from the caller's state rather than owning it", () => {
    const { rerender } = render(<Grid />)
    const row = screen.getByRole("cell", { name: "build" }).parentElement
    expect(row).not.toHaveAttribute("data-state")

    rerender(<Grid selected />)
    expect(screen.getByRole("cell", { name: "build" }).parentElement).toHaveAttribute(
      "data-state",
      "selected"
    )
  })

  it("stamps a data-slot on every section", () => {
    const { container } = render(<Grid />)

    for (const slot of [
      "table-container",
      "table",
      "table-header",
      "table-body",
      "table-footer",
      "table-row",
      "table-head",
      "table-cell",
      "table-caption",
    ]) {
      expect(container.querySelector(`[data-slot='${slot}']`)).not.toBeNull()
    }
  })

  it("merges caller classes rather than emitting a conflicting pair", () => {
    render(
      <Table className="text-xs">
        <TableBody>
          <TableRow>
            <TableCell className="p-4">build</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )

    const table = screen.getByRole("table")
    expect(table.className).toContain("text-xs")
    // cn() resolved text-sm against text-xs, and p-2 against p-4.
    expect(table.className).not.toContain("text-sm")
    const cell = screen.getByRole("cell", { name: "build" })
    expect(cell.className).toContain("p-4")
    expect(cell.className).not.toContain("p-2")
  })

  it("forwards DOM props including a colspan on the cell", () => {
    render(
      <Table>
        <TableBody>
          <TableRow id="empty-row">
            <TableCell colSpan={2}>No runs yet</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )

    expect(screen.getByRole("cell", { name: "No runs yet" })).toHaveAttribute("colspan", "2")
    expect(document.getElementById("empty-row")).toHaveAttribute("data-slot", "table-row")
  })

  it("supports a scoped row header", () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableHead scope="row">build</TableHead>
            <TableCell>passed</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )

    expect(screen.getByRole("rowheader", { name: "build" })).toHaveAttribute(
      "data-slot",
      "table-head"
    )
  })
})
