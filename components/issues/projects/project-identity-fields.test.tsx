/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import userEvent from "@testing-library/user-event"
import { render, screen } from "@testing-library/react"
import {
  EMPTY_PROJECT_IDENTITY,
  ProjectIdentityFields,
  resolveProjectIdentity,
} from "./project-identity-fields"

const taken = (...keys: string[]) => new Set(keys)

describe("resolveProjectIdentity", () => {
  it("derives a key from the name until the user edits it", () => {
    const verdict = resolveProjectIdentity({ ...EMPTY_PROJECT_IDENTITY, name: "Mercury" }, taken())
    expect(verdict.key.length).toBeGreaterThan(0)
    expect(verdict.valid).toBe(true)
  })

  it("stops deriving once the key is touched", () => {
    const verdict = resolveProjectIdentity(
      { name: "Mercury", keyInput: "MINE", keyTouched: true },
      taken()
    )
    expect(verdict.key).toBe("MINE")
  })

  it("is not valid without a name", () => {
    expect(resolveProjectIdentity(EMPTY_PROJECT_IDENTITY, taken()).valid).toBe(false)
  })

  it("is not valid with a name that is only whitespace", () => {
    expect(resolveProjectIdentity({ ...EMPTY_PROJECT_IDENTITY, name: "   " }, taken()).valid).toBe(
      false
    )
  })

  it("rejects a malformed key", () => {
    const verdict = resolveProjectIdentity(
      { name: "Mercury", keyInput: "not-a-key", keyTouched: true },
      taken()
    )
    expect(verdict.invalid).toBe(true)
    expect(verdict.valid).toBe(false)
  })

  it("rejects a key already in use", () => {
    const verdict = resolveProjectIdentity(
      { name: "Mercury", keyInput: "MERC", keyTouched: true },
      taken("MERC")
    )
    expect(verdict.taken).toBe(true)
    expect(verdict.valid).toBe(false)
  })

  it("derives around a collision rather than proposing a taken key", () => {
    const first = resolveProjectIdentity({ ...EMPTY_PROJECT_IDENTITY, name: "Mercury" }, taken())
    const second = resolveProjectIdentity(
      { ...EMPTY_PROJECT_IDENTITY, name: "Mercury" },
      taken(first.key)
    )
    expect(second.key).not.toBe(first.key)
    expect(second.taken).toBe(false)
  })
})

describe("ProjectIdentityFields", () => {
  function renderFields(over: Partial<React.ComponentProps<typeof ProjectIdentityFields>> = {}) {
    const onChange = jest.fn()
    const props: React.ComponentProps<typeof ProjectIdentityFields> = {
      value: EMPTY_PROJECT_IDENTITY,
      onChange,
      takenKeys: taken(),
      idPrefix: "p",
      ...over,
    }
    return { onChange, ...render(<ProjectIdentityFields {...props} />) }
  }

  it("shows the derived key without the user typing one", () => {
    renderFields({ value: { ...EMPTY_PROJECT_IDENTITY, name: "Mercury" } })
    expect((screen.getByTestId("p-key") as HTMLInputElement).value.length).toBeGreaterThan(0)
  })

  it("reports a name change", async () => {
    const user = userEvent.setup()
    const { onChange } = renderFields()
    await user.type(screen.getByTestId("p-name"), "M")
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "M" }))
  })

  it("marks the key as touched and upper-cases it", async () => {
    const user = userEvent.setup()
    const { onChange } = renderFields()
    await user.type(screen.getByTestId("p-key"), "a")
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ keyTouched: true, keyInput: "A" })
    )
  })

  it("explains a malformed key", () => {
    renderFields({ value: { name: "Mercury", keyInput: "bad key", keyTouched: true } })
    expect(screen.getByText("projects.keyInvalid")).toBeInTheDocument()
  })

  it("explains a taken key", () => {
    renderFields({
      value: { name: "Mercury", keyInput: "MERC", keyTouched: true },
      takenKeys: taken("MERC"),
    })
    expect(screen.getByText("projects.keyTaken")).toBeInTheDocument()
  })

  it("shows the plain hint when the key is fine", () => {
    renderFields({ value: { ...EMPTY_PROJECT_IDENTITY, name: "Mercury" } })
    expect(screen.getByText("projects.keyHint")).toBeInTheDocument()
  })
})
