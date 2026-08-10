/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { EXPR_DRAG_MIME } from "@/lib/workflow/editor/expr-ref"
import { DataTableView } from "./data-table-view"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("DataTableView", () => {
  it("renders object fields with their types and formatted samples", () => {
    render(
      <DataTableView
        sourceNodeId="source"
        item={{ name: "Cognia", count: 2, nested: { ok: true } }}
        basePrefix={["result"]}
      />
    )

    expect(screen.getAllByTestId("data-field-row")).toHaveLength(3)
    expect(screen.getByText("name")).toBeInTheDocument()
    expect(screen.getByText('"Cognia"')).toBeInTheDocument()
    expect(screen.getByText("number")).toBeInTheDocument()
    expect(screen.getByText("{1}")).toBeInTheDocument()
  })

  it("renders the translated empty state for an empty object", () => {
    render(<DataTableView sourceNodeId="source" item={{}} basePrefix={[]} />)

    expect(screen.getByText("emptyObject")).toBeInTheDocument()
    expect(screen.queryByTestId("data-table-view")).not.toBeInTheDocument()
  })

  it("renders a primitive value row and preserves its drag expression payload", () => {
    render(<DataTableView sourceNodeId="source" item={["a", "b"]} basePrefix={[0]} />)
    const row = screen.getByTestId("data-field-row")
    const setData = jest.fn()
    const dataTransfer = { setData, effectAllowed: "none" }

    expect(row).toHaveTextContent("valueLabel")
    expect(row).toHaveTextContent("array")
    expect(row).toHaveTextContent("[2]")

    fireEvent.dragStart(row, { dataTransfer })

    expect(setData).toHaveBeenCalledWith(
      EXPR_DRAG_MIME,
      JSON.stringify({ nodeId: "source", segments: [0] })
    )
    expect(setData).toHaveBeenCalledWith("text/plain", "{{ $node['source'][0] }}")
    expect(dataTransfer.effectAllowed).toBe("copy")
  })
})
