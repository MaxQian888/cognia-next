/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { StructuredJsonField, parseJsonRows } from "./structured-json-field"

const messages = {
  workflows: {
    forms: {
      structured: {
        useJson: "Edit as JSON",
        useRows: "Edit as rows",
        jsonOnly: "This value isn't a JSON array, so the row editor would discard it.",
        removeRow: "Remove row",
      },
    },
  },
}

interface Row {
  title?: string
}

function renderField(
  overrides: Partial<React.ComponentProps<typeof StructuredJsonField<Row>>> = {}
) {
  const onChange = jest.fn()
  const raw = String(overrides.raw ?? "[]")
  const parsed = parseJsonRows<Row>(raw)
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StructuredJsonField<Row>
        id="f"
        rows={parsed.rows}
        raw={raw}
        jsonOnly={parsed.jsonOnly}
        onChange={onChange}
        makeRow={() => ({ title: "" })}
        addLabel="Add"
        renderRow={(row, index, patch) => (
          <input
            data-testid={`row-${index}`}
            value={row.title ?? ""}
            onChange={(e) => patch({ title: e.target.value })}
          />
        )}
        {...overrides}
      />
    </NextIntlClientProvider>
  )
  return onChange
}

describe("parseJsonRows", () => {
  it("treats an empty value as an empty editable list", () => {
    expect(parseJsonRows("")).toEqual({ rows: [], jsonOnly: false })
  })

  it("pins JSON mode when the stored value is not an array", () => {
    // An expression, or a half-typed array. The row editor would silently
    // discard either one, so it must not be offered.
    expect(parseJsonRows("{{ $json.steps }}").jsonOnly).toBe(true)
    expect(parseJsonRows('{"a":1}').jsonOnly).toBe(true)
  })
})

describe("StructuredJsonField", () => {
  it("writes both shapes in one call when a row is added", () => {
    const onChange = renderField()
    fireEvent.click(screen.getByTestId("f-add"))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith([{ title: "" }], JSON.stringify([{ title: "" }], null, 2))
  })

  it("edits and removes a row", () => {
    const onChange = renderField({ raw: '[{"title":"a"}]' })
    fireEvent.change(screen.getByTestId("row-0"), { target: { value: "b" } })
    expect(onChange).toHaveBeenCalledWith([{ title: "b" }], expect.stringContaining('"b"'))
    fireEvent.click(screen.getByTestId("f-remove-0"))
    expect(onChange).toHaveBeenCalledWith([], "[]")
  })

  it("offers a JSON escape hatch and comes back", () => {
    renderField({ raw: '[{"title":"a"}]' })
    fireEvent.click(screen.getByTestId("f-use-json"))
    expect(screen.getByTestId("f-json")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("f-use-rows"))
    expect(screen.getByTestId("f-rows")).toBeInTheDocument()
  })

  it("keeps a non-array value in JSON mode with no way back", () => {
    renderField({ raw: "{{ $json.steps }}" })
    expect(screen.getByTestId("f-json")).toBeInTheDocument()
    expect(screen.queryByTestId("f-use-rows")).toBeNull()
  })

  it("holds the last valid rows while the JSON is mid-edit", () => {
    const onChange = renderField({ raw: '[{"title":"a"}]' })
    fireEvent.click(screen.getByTestId("f-use-json"))
    fireEvent.change(screen.getByTestId("f-json"), { target: { value: '[{"title":' } })
    // The text is kept verbatim. The parsed rows stay at their last valid
    // value rather than collapsing to empty mid-keystroke.
    expect(onChange).toHaveBeenCalledWith([{ title: "a" }], '[{"title":')
  })
})
