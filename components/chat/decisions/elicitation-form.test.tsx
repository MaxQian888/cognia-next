/**
 * @jest-environment jsdom
 */
import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  ElicitationForm,
  elicitationChoices,
  initialElicitationValues,
  isElicitationComplete,
  type ElicitationValues,
} from "./elicitation-form"
import type { AcpElicitationRequest } from "@/types/agent/external-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function request(overrides: Partial<AcpElicitationRequest> = {}): AcpElicitationRequest {
  return {
    id: "e1",
    mode: "form",
    message: "Which branch?",
    raw: {},
    requestedSchema: {
      type: "object",
      properties: { branch: { type: "string", title: "Branch" } },
      required: ["branch"],
    },
    ...overrides,
  }
}

/** Mirrors how a caller owns the values — the form itself is controlled. */
function Harness({ req }: { req: AcpElicitationRequest }) {
  const [values, setValues] = useState<ElicitationValues>(() =>
    initialElicitationValues(req.requestedSchema?.properties ?? {})
  )
  return <ElicitationForm request={req} values={values} onValuesChange={setValues} />
}

function choiceOrTextRequest(): AcpElicitationRequest {
  return request({
    requestedSchema: {
      type: "object",
      properties: {
        q0: { type: "string", title: "Which environment?", enum: ["Local", "Cloud"] },
        q0_notes: { type: "string", title: "Which environment?", format: "multiline" },
        q1: {
          type: "array",
          title: "Which checks?",
          items: { type: "string", enum: ["Types", "Tests"] },
        },
        q1_notes: { type: "string", title: "Which checks?", format: "multiline" },
      },
      required: [],
    },
    _meta: {
      userInput: {
        questions: [
          {
            id: "q0",
            notesField: "q0_notes",
            question: "Which environment?",
            options: [{ label: "Local", description: "Use this computer" }, { label: "Cloud" }],
            multiple: false,
            isOther: true,
          },
          {
            id: "q1",
            notesField: "q1_notes",
            question: "Which checks?",
            options: [{ label: "Types" }, { label: "Tests", description: "Run focused tests" }],
            multiple: true,
            isOther: true,
          },
        ],
      },
    },
  })
}

describe("elicitation helpers", () => {
  it("requires a choice or free text for every grouped question", () => {
    const req = choiceOrTextRequest()
    const complete = (values: ElicitationValues) =>
      isElicitationComplete(req.requestedSchema!.properties, [], values, req)
    expect(complete({})).toBe(false)
    expect(complete({ q0: "Local", q1: [] })).toBe(false)
    expect(complete({ q0: "Local", q1_notes: "   " })).toBe(false)
    expect(complete({ q0: "Local", q1: ["Types", "Tests"] })).toBe(true)
    expect(complete({ q0_notes: "My own environment", q1: ["Tests"] })).toBe(true)
    expect(complete({ q0_notes: "Custom", q1_notes: "A custom check" })).toBe(true)
  })

  it("reads choices from either ACP spelling, preferring oneOf's labels", () => {
    expect(elicitationChoices({ type: "string", oneOf: [{ const: "a", title: "Alpha" }] })).toEqual(
      [{ value: "a", label: "Alpha" }]
    )
    expect(elicitationChoices({ type: "string", enum: ["b"] })).toEqual([
      { value: "b", label: "b" },
    ])
    expect(elicitationChoices({ type: "string" })).toEqual([])
  })

  it("keeps a supplied default instead of blanking the field", () => {
    expect(initialElicitationValues({ body: { type: "string", default: "prefilled" } })).toEqual({
      body: "prefilled",
    })
  })

  /**
   * `false` is a real answer to "confirm?", not a missing one — treating it as
   * incomplete would leave Submit disabled on the only answer the user gave.
   */
  it("counts a false boolean as answered but a blank string as missing", () => {
    const properties = { ok: { type: "boolean" as const }, name: { type: "string" as const } }
    expect(isElicitationComplete(properties, ["ok"], { ok: false })).toBe(true)
    expect(isElicitationComplete(properties, ["name"], { name: "   " })).toBe(false)
    expect(isElicitationComplete(properties, ["name"], { name: "x" })).toBe(true)
    // A required key the schema never declared cannot be enforced.
    expect(isElicitationComplete(properties, ["missing"], {})).toBe(true)
  })
})

describe("<ElicitationForm />", () => {
  it("shows the selected option preview as text", async () => {
    const req = choiceOrTextRequest()
    const groups = (req._meta!.userInput as { questions: Array<{ options: unknown[] }> }).questions
    groups[0].options = [
      { label: "Local", preview: "<script>not executable</script>\nLocal plan" },
      { label: "Cloud", preview: "Cloud plan" },
    ]
    render(<Harness req={req} />)
    expect(screen.queryByText(/Local plan/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("radio", { name: "Local" }))
    expect(screen.getByText(/Local plan/)).toHaveTextContent("<script>not executable</script>")
    expect(document.querySelector("script")).toBeNull()
    await userEvent.click(screen.getByRole("radio", { name: "Cloud" }))
    expect(screen.queryByText(/Local plan/)).not.toBeInTheDocument()
    expect(screen.getByText("Cloud plan")).toBeInTheDocument()
  })

  it("uses only the notes field when a question offers no choices", () => {
    const req = choiceOrTextRequest()
    const groups = (req._meta!.userInput as { questions: Array<{ options: unknown[] }> }).questions
    groups[0].options = []
    req.requestedSchema!.properties.q0 = { type: "string", title: "Which environment?" }
    render(<Harness req={req} />)
    expect(screen.queryByLabelText("Which environment?")).not.toBeInTheDocument()
    expect(screen.getAllByRole("textbox", { name: "otherResponse" })).toHaveLength(2)
  })

  it("reuses choices and text fields with localized notes labels and option descriptions", async () => {
    const user = userEvent.setup()
    render(<Harness req={choiceOrTextRequest()} />)
    expect(screen.getByText("Use this computer")).toBeInTheDocument()
    expect(screen.getByText("Run focused tests")).toBeInTheDocument()
    const notes = screen.getAllByRole("textbox", { name: "otherResponse" })
    expect(notes).toHaveLength(2)
    await user.type(notes[0], "A different environment")
    expect(notes[0]).toHaveValue("A different environment")
    await user.click(screen.getByRole("checkbox", { name: "Types" }))
    await user.click(screen.getByRole("checkbox", { name: /Tests/ }))
    expect(screen.getByRole("checkbox", { name: "Types" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: /Tests/ })).toBeChecked()
  })

  it("honors portable property order, ignores duplicates and unknown fields, and appends omitted fields", () => {
    render(
      <Harness
        req={request({
          propertyOrder: ["second", "missing", "second"],
          requestedSchema: {
            type: "object",
            properties: {
              first: { type: "string" },
              second: { type: "string" },
              third: { type: "string" },
            },
          },
        })}
      />
    )
    expect(screen.getAllByRole("textbox").map((field) => field.id)).toEqual([
      "elicitation-e1-second",
      "elicitation-e1-first",
      "elicitation-e1-third",
    ])
  })
  it("renders a choice list as radios", async () => {
    const user = userEvent.setup()
    render(
      <Harness
        req={request({
          requestedSchema: {
            type: "object",
            properties: { pick: { type: "string", title: "Pick", enum: ["one", "two"] } },
            required: ["pick"],
          },
        })}
      />
    )
    await user.click(screen.getByLabelText("two"))
    expect(screen.getByLabelText("two")).toBeChecked()
  })

  /** `writeOnly` is how ACP marks a secret; it must never render in the clear. */
  it("masks a write-only field", () => {
    render(
      <Harness
        req={request({
          requestedSchema: {
            type: "object",
            properties: { token: { type: "string", title: "Token", writeOnly: true } },
            required: ["token"],
          },
        })}
      />
    )
    expect(screen.getByLabelText("Token")).toHaveAttribute("type", "password")
  })

  /**
   * A prefilled string is an `editor` dialog: the user is meant to revise a
   * body of text, not retype one line into a single-line input.
   */
  it("gives a prefilled string a textarea", () => {
    render(
      <Harness
        req={request({
          requestedSchema: {
            type: "object",
            properties: { body: { type: "string", title: "Body", default: "hello" } },
          },
        })}
      />
    )
    expect(screen.getByLabelText("Body").tagName).toBe("TEXTAREA")
  })

  it("renders a url-mode request as a link with its punycode warning", () => {
    render(
      <Harness
        req={request({
          mode: "url",
          url: "https://example.test/auth",
          hasPunycodeWarning: true,
          requestedSchema: undefined,
        })}
      />
    )
    expect(screen.getByTestId("elicitation-url")).toBeInTheDocument()
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.test/auth")
    expect(screen.getByText("punycodeWarning")).toBeInTheDocument()
  })

  /**
   * A multi-select used to fall through to the single-line text input, so an
   * agent asking the user to pick several options got a box to type them into
   * by hand. Labels come from `items.oneOf`; `items.enum` carries values only.
   */
  it("renders an array field as a labelled checkbox group", async () => {
    const user = userEvent.setup()
    render(
      <Harness
        req={request({
          requestedSchema: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                title: "Tags",
                items: {
                  type: "string",
                  oneOf: [
                    { const: "a", title: "Alpha" },
                    { const: "b", title: "Beta" },
                  ],
                },
              },
            },
            required: ["tags"],
          },
        })}
      />
    )
    await user.click(screen.getByLabelText("Alpha"))
    await user.click(screen.getByLabelText("Beta"))
    expect(screen.getByLabelText("Alpha")).toBeChecked()
    expect(screen.getByLabelText("Beta")).toBeChecked()

    await user.click(screen.getByLabelText("Alpha"))
    expect(screen.getByLabelText("Alpha")).not.toBeChecked()
    expect(screen.getByLabelText("Beta")).toBeChecked()
  })

  it("falls back to bare values when an array only carries an enum", () => {
    render(
      <Harness
        req={request({
          requestedSchema: {
            type: "object",
            properties: {
              tags: { type: "array", title: "Tags", items: { type: "string", enum: ["x"] } },
            },
          },
        })}
      />
    )
    expect(screen.getByLabelText("x")).toBeInTheDocument()
  })

  it("renders read-only for a watcher who may not answer", () => {
    const values = { branch: "" }
    render(
      <ElicitationForm request={request()} values={values} onValuesChange={jest.fn()} disabled />
    )
    expect(screen.getByLabelText("Branch")).toBeDisabled()
  })
})
