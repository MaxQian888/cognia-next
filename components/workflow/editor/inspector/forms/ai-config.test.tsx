/**
 * @jest-environment jsdom
 *
 * Coverage for the Theme B additions to the AI config forms: ai.prompt
 * structured-output fields, ai.extract required-fields, ai.embed provider.
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

// Replace the heavy CodeMirror ExpressionField with a plain textarea so these
// tests stay fast and focus on the new plain fields.
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({
    value,
    onChange,
    id,
  }: {
    value: string
    onChange: (v: string) => void
    id?: string
  }) => <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} />,
}))

import { AiPromptConfig, AiExtractConfig, AiEmbedConfig } from "./index"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("AiPromptConfig — structured output (B1)", () => {
  it("hides the JSON shape field in text mode", () => {
    wrap(<AiPromptConfig params={{ userPrompt: "x" }} onChange={jest.fn()} />)
    expect(screen.queryByLabelText("JSON shape (optional)")).toBeNull()
  })

  it("shows + edits the JSON shape field in json mode", () => {
    const onChange = jest.fn()
    wrap(
      <AiPromptConfig params={{ userPrompt: "x", responseFormat: "json" }} onChange={onChange} />
    )
    const schema = screen.getByLabelText("JSON shape (optional)")
    fireEvent.change(schema, { target: { value: '{"a":"string"}' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ jsonSchema: '{"a":"string"}' }))
  })
})

describe("AiPromptConfig — v2 routed mode + PII gate", () => {
  it("hides v2 controls for typeVersion 1 nodes", () => {
    wrap(<AiPromptConfig params={{ userPrompt: "x" }} onChange={jest.fn()} typeVersion={1} />)
    expect(screen.queryByLabelText("Provider mode")).toBeNull()
    expect(screen.queryByLabelText("PII gate")).toBeNull()
  })

  it("shows mode + PII gate selects for typeVersion 2 and keeps explicit fields", () => {
    wrap(<AiPromptConfig params={{ userPrompt: "x" }} onChange={jest.fn()} typeVersion={2} />)
    expect(screen.getByLabelText("Provider mode")).toBeInTheDocument()
    expect(screen.getByLabelText("PII gate")).toBeInTheDocument()
    // Default mode = explicit → provider/model/key fields stay visible.
    expect(screen.getByLabelText("Provider")).toBeInTheDocument()
    expect(screen.queryByLabelText("Model alias")).toBeNull()
  })

  it("swaps explicit credential fields for the model alias in routed mode", () => {
    const onChange = jest.fn()
    wrap(
      <AiPromptConfig
        params={{ userPrompt: "x", mode: "routed" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    expect(screen.queryByLabelText("Provider")).toBeNull()
    expect(screen.queryByLabelText("API key")).toBeNull()
    const alias = screen.getByLabelText("Model alias")
    fireEvent.change(alias, { target: { value: "fast" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelAlias: "fast" }))
  })
})

describe("AiExtractConfig — required fields (B4)", () => {
  it("parses a comma-separated required list into an array", () => {
    const onChange = jest.fn()
    wrap(<AiExtractConfig params={{ input: "x" }} onChange={onChange} />)
    const field = screen.getByLabelText("Required fields (optional)")
    fireEvent.change(field, { target: { value: "name, amount ," } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ required: ["name", "amount"] }))
  })

  it("renders an existing required array as a joined string", () => {
    wrap(<AiExtractConfig params={{ input: "x", required: ["a", "b"] }} onChange={jest.fn()} />)
    expect((screen.getByLabelText("Required fields (optional)") as HTMLInputElement).value).toBe(
      "a, b"
    )
  })
})

describe("AiEmbedConfig — provider (B3)", () => {
  it("edits the model field", () => {
    const onChange = jest.fn()
    wrap(<AiEmbedConfig params={{ input: "x" }} onChange={onChange} />)
    const model = screen.getByLabelText("Model (optional)")
    fireEvent.change(model, { target: { value: "text-embedding-3-small" } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-small" })
    )
  })

  it("edits the api key field", () => {
    const onChange = jest.fn()
    wrap(<AiEmbedConfig params={{ input: "x" }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText("API key (optional)"), { target: { value: "k" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "k" }))
  })
})
