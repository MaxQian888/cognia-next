/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import { EXPR_DRAG_MIME } from "@/lib/workflow/editor/expr-ref"
import { DataSchemaView } from "./data-schema-view"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

describe("DataSchemaView", () => {
  it("renders flattened schema properties through SchemaDisplay", () => {
    render(
      <DataSchemaView
        sourceNodeId="n_source"
        item={{ user: { name: "Ada" }, active: true }}
        basePrefix={["output"]}
      />
    )

    expect(screen.getByTestId("data-schema-view")).toBeInTheDocument()
    expect(screen.getByText("user.name")).toBeInTheDocument()
    expect(screen.getByText("active")).toBeInTheDocument()
    expect(screen.getByText('"Ada"')).toBeInTheDocument()
  })

  it("keeps schema properties as expression drag sources", () => {
    const setData = jest.fn()
    render(<DataSchemaView sourceNodeId="n_source" item={{ count: 3 }} basePrefix={["output"]} />)

    fireEvent.dragStart(screen.getByText("count").closest('[data-testid="data-field-row"]')!, {
      dataTransfer: { setData, effectAllowed: "none" },
    })

    expect(setData).toHaveBeenCalledWith(EXPR_DRAG_MIME, expect.stringContaining("n_source"))
    expect(setData).toHaveBeenCalledWith("text/plain", expect.stringContaining("$node['n_source']"))
  })

  it("renders the localized empty state for scalar data", () => {
    render(<DataSchemaView sourceNodeId="n_source" item="plain text" basePrefix={[]} />)
    expect(screen.getByText("schemaEmpty")).toBeInTheDocument()
  })
})
