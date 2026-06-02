/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { DataTableView } from "./data-table-view"
import { DataJsonView } from "./data-json-view"
import { DataSchemaView } from "./data-schema-view"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("DataTableView", () => {
  it("renders key rows for an object item", () => {
    wrap(<DataTableView sourceNodeId="n" item={{ foo: 1, bar: "x" }} basePrefix={[]} />)
    expect(screen.getByText("foo")).toBeInTheDocument()
    expect(screen.getByText("bar")).toBeInTheDocument()
  })

  it("renders an empty-object notice", () => {
    wrap(<DataTableView sourceNodeId="n" item={{}} basePrefix={[]} />)
    expect(screen.getByText("Empty object")).toBeInTheDocument()
  })

  it("renders a single value row for a primitive item", () => {
    wrap(<DataTableView sourceNodeId="n" item={42} basePrefix={[0]} />)
    expect(screen.getByText("value")).toBeInTheDocument()
    expect(screen.getByText("42")).toBeInTheDocument()
  })
})

describe("DataJsonView", () => {
  it("pretty-prints the item", () => {
    wrap(<DataJsonView item={{ a: 1 }} />)
    expect(screen.getByTestId("data-json-view").textContent).toContain('"a": 1')
  })

  it("renders 'undefined' for undefined items", () => {
    wrap(<DataJsonView item={undefined} />)
    expect(screen.getByTestId("data-json-view").textContent).toBe("undefined")
  })

  it("falls back gracefully for non-serializable (circular) items", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    wrap(<DataJsonView item={circular} />)
    expect(screen.getByTestId("data-json-view")).toBeInTheDocument()
  })
})

describe("DataSchemaView", () => {
  it("renders flattened rows", () => {
    wrap(<DataSchemaView sourceNodeId="n" item={{ a: { b: 1 } }} basePrefix={[]} />)
    expect(screen.getByText("a.b")).toBeInTheDocument()
  })

  it("renders an empty notice for a primitive item", () => {
    wrap(<DataSchemaView sourceNodeId="n" item={"plain"} basePrefix={[]} />)
    expect(screen.getByText("No fields to map.")).toBeInTheDocument()
  })
})
