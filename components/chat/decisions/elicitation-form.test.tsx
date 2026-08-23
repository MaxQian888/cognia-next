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

describe("elicitation helpers", () => {
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
