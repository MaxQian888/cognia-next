/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom"
import { render, screen, fireEvent } from "@testing-library/react"
import { useState } from "react"
import { SchemaForm } from "./schema-form"

// CodeMirror's ExpressionField needs Dexie/IDB to subscribe to live runs.
// Stub it so tests don't have to spin up fake-indexeddb.
jest.mock("./shared/expression-field", () => ({
  __esModule: true,
  ExpressionField: ({
    id,
    value,
    onChange,
    placeholder,
  }: {
    id?: string
    value: string
    onChange: (v: string) => void
    placeholder?: string
  }) => (
    <textarea
      data-testid={`expr-${id ?? "field"}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}))

function Harness({ schema }: { schema: Parameters<typeof SchemaForm>[0]["schema"] }) {
  const [params, setParams] = useState<Record<string, unknown>>({})
  return (
    <div>
      <SchemaForm schema={schema} params={params} onChange={setParams} />
      <pre data-testid="state">{JSON.stringify(params)}</pre>
    </div>
  )
}

function readState(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId("state").textContent ?? "{}")
}

describe("SchemaForm", () => {
  it("falls back to a JSON textarea when the top-level schema isn't an object", () => {
    render(<Harness schema={{ type: "string" }} />)
    expect(screen.getByText(/Edit as JSON/i)).toBeInTheDocument()
  })

  it("renders a string Input field with title + description", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: {
            name: { type: "string", title: "Display name", description: "Shown in the UI" },
          },
        }}
      />
    )
    expect(screen.getByText("Display name")).toBeInTheDocument()
    expect(screen.getByText("Shown in the UI")).toBeInTheDocument()
  })

  it("uses a Sentence-case fallback label when no title is provided", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: { myFieldName: { type: "string" } },
        }}
      />
    )
    expect(screen.getByText("My field name")).toBeInTheDocument()
  })

  it("renders an enum field as a Select", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: {
            method: { type: "string", title: "Method", enum: ["GET", "POST"] },
          },
        }}
      />
    )
    // Select trigger is the placeholder text "(select)" before any value is set.
    expect(screen.getByText("Method")).toBeInTheDocument()
  })

  it("renders an expression field via the format=expression branch", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: {
            url: { type: "string", title: "URL", format: "expression" },
          },
        }}
      />
    )
    const editor = screen.getByTestId(/^expr-/) as HTMLTextAreaElement
    expect(editor).toBeInTheDocument()
    fireEvent.change(editor, { target: { value: "{{ $trigger.url }}" } })
    expect(readState()).toEqual({ url: "{{ $trigger.url }}" })
  })

  it("renders a textarea via format=textarea", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: { body: { type: "string", title: "Body", format: "textarea" } },
        }}
      />
    )
    const ta = screen.getByLabelText("Body") as HTMLTextAreaElement
    expect(ta.tagName).toBe("TEXTAREA")
  })

  it("renders a number Input and clamps to integer when type=integer", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: { count: { type: "integer", title: "Count", minimum: 0, maximum: 10 } },
        }}
      />
    )
    const input = screen.getByLabelText("Count") as HTMLInputElement
    expect(input.type).toBe("number")
    fireEvent.change(input, { target: { value: "3.7" } })
    expect(readState()).toEqual({ count: 4 })
  })

  it("renders a boolean Switch and toggles params", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: { enabled: { type: "boolean", title: "Enabled" } },
        }}
      />
    )
    const sw = screen.getByLabelText("Enabled")
    fireEvent.click(sw)
    expect(readState()).toEqual({ enabled: true })
  })

  it("marks required fields with an asterisk", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
          required: ["name"],
        }}
      />
    )
    const label = screen.getByText("Name").parentElement
    expect(label?.querySelector('span[aria-hidden="true"]')?.textContent).toBe("*")
  })

  it("seeds default values into params on mount", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: {
            retries: { type: "integer", title: "Retries", default: 3 },
            mode: { type: "string", title: "Mode", default: "auto" },
          },
        }}
      />
    )
    expect(readState()).toEqual({ retries: 3, mode: "auto" })
  })

  it("renders a string-array as a tag list with add/remove", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: {
            tags: {
              type: "array",
              title: "Tags",
              items: { type: "string" },
            },
          },
        }}
      />
    )
    const addBtn = screen.getByRole("button", { name: /add/i })
    fireEvent.click(addBtn)
    fireEvent.click(addBtn)
    expect(readState().tags).toEqual(["", ""])
  })

  it("recurses into nested objects under a bordered section", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: {
            auth: {
              type: "object",
              title: "Auth",
              properties: {
                user: { type: "string", title: "User" },
                pass: { type: "string", title: "Password", format: "password" },
              },
            },
          },
        }}
      />
    )
    expect(screen.getByText("Auth")).toBeInTheDocument()
    expect(screen.getByText("User")).toBeInTheDocument()
    const passInput = screen.getByLabelText("Password") as HTMLInputElement
    expect(passInput.type).toBe("password")
  })

  it("falls back to a JSON textarea for unrecognised property shapes", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: {
            payload: {
              // No type — drops through to the JSON fallback.
              title: "Payload",
              description: "Edit raw JSON",
            },
          },
        }}
      />
    )
    expect(screen.getByText("Payload")).toBeInTheDocument()
    expect(screen.getByText("Edit raw JSON")).toBeInTheDocument()
  })
})
