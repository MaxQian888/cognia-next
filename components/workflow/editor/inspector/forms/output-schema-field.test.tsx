/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import {
  jsonSchemaToRows,
  rowsToJsonSchema,
  OutputSchemaField,
  TypedOutputFields,
} from "./output-schema-field"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("jsonSchemaToRows / rowsToJsonSchema", () => {
  const schema = {
    type: "object",
    properties: {
      verdict: { type: "string", description: "the call" },
      score: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["verdict"],
  }

  it("round-trips an object schema through rows", () => {
    const rows = jsonSchemaToRows(schema)
    expect(rows).toEqual([
      { name: "verdict", type: "string", required: true, description: "the call" },
      { name: "score", type: "number", required: false, description: "" },
      { name: "tags", type: "array", required: false, description: "" },
    ])
    const back = rowsToJsonSchema(rows)
    expect(back).toEqual({
      type: "object",
      properties: {
        verdict: { type: "string", description: "the call" },
        score: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["verdict"],
    })
  })

  it("returns [] for non-object schemas", () => {
    expect(jsonSchemaToRows(undefined)).toEqual([])
    expect(jsonSchemaToRows({ type: "string" })).toEqual([])
  })

  it("returns undefined when no named rows", () => {
    expect(rowsToJsonSchema([])).toBeUndefined()
    expect(
      rowsToJsonSchema([{ name: "  ", type: "string", required: false, description: "" }])
    ).toBeUndefined()
  })

  it("omits the required array when nothing is required", () => {
    const out = rowsToJsonSchema([{ name: "a", type: "string", required: false, description: "" }])
    expect(out).toEqual({ type: "object", properties: { a: { type: "string" } } })
  })

  it("falls back to string for unknown types", () => {
    const rows = jsonSchemaToRows({
      type: "object",
      properties: { x: { type: "weird" } },
    })
    expect(rows[0].type).toBe("string")
  })
})

describe("OutputSchemaField", () => {
  it("adds a field and emits a schema once a name is typed", () => {
    const onChange = jest.fn()
    wrap(<OutputSchemaField value={undefined} onChange={onChange} />)
    fireEvent.click(screen.getByText("Add field"))
    // The empty row alone produces no schema.
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    fireEvent.change(screen.getByLabelText("Field name"), { target: { value: "verdict" } })
    expect(onChange).toHaveBeenLastCalledWith({
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    })
  })

  it("removes a field", () => {
    const onChange = jest.fn()
    wrap(
      <OutputSchemaField
        value={{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByLabelText("Remove field"))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it("edits a field's description and required flag, then removes it", () => {
    const onChange = jest.fn()
    wrap(
      <OutputSchemaField
        value={{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "the a field" } })
    expect(onChange).toHaveBeenLastCalledWith({
      type: "object",
      properties: { a: { type: "string", description: "the a field" } },
      required: ["a"],
    })
    // Toggle required off → the required array drops away (description from the
    // prior edit is retained in the local buffer).
    fireEvent.click(screen.getByLabelText("Required"))
    expect(onChange).toHaveBeenLastCalledWith({
      type: "object",
      properties: { a: { type: "string", description: "the a field" } },
    })
    fireEvent.click(screen.getByLabelText("Remove field"))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it("toggles back from raw mode to fields mode", () => {
    wrap(<OutputSchemaField value={undefined} onChange={jest.fn()} />)
    fireEvent.click(screen.getByText("Edit as JSON"))
    expect(screen.getByLabelText("JSON Schema")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Edit as fields"))
    expect(screen.getByText("Add field")).toBeInTheDocument()
  })

  it("re-derives rows from an external value change", () => {
    const { rerender } = wrap(<OutputSchemaField value={undefined} onChange={jest.fn()} />)
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <OutputSchemaField
          value={{ type: "object", properties: { z: { type: "number" } } }}
          onChange={jest.fn()}
        />
      </NextIntlClientProvider>
    )
    expect((screen.getByLabelText("Field name") as HTMLInputElement).value).toBe("z")
  })

  it("switches to raw mode and parses edited JSON", () => {
    const onChange = jest.fn()
    wrap(<OutputSchemaField value={undefined} onChange={onChange} />)
    fireEvent.click(screen.getByText("Edit as JSON"))
    const raw = screen.getByLabelText("JSON Schema")
    fireEvent.change(raw, {
      target: { value: '{"type":"object","properties":{"q":{"type":"string"}}}' },
    })
    expect(onChange).toHaveBeenLastCalledWith({
      type: "object",
      properties: { q: { type: "string" } },
    })
  })

  it("does not propagate broken JSON in raw mode", () => {
    const onChange = jest.fn()
    wrap(<OutputSchemaField value={undefined} onChange={onChange} />)
    fireEvent.click(screen.getByText("Edit as JSON"))
    fireEvent.change(screen.getByLabelText("JSON Schema"), { target: { value: "{ broken" } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("TypedOutputFields", () => {
  it("shows the violation select only once a schema exists", () => {
    const { rerender } = wrap(<TypedOutputFields params={{}} onChange={jest.fn()} idPrefix="t" />)
    expect(screen.queryByLabelText("On schema violation")).toBeNull()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TypedOutputFields
          params={{ outputSchema: { type: "object", properties: { a: { type: "string" } } } }}
          onChange={jest.fn()}
          idPrefix="t"
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByLabelText("On schema violation")).toBeInTheDocument()
  })
})
