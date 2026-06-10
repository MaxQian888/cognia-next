/**
 * @jest-environment node
 */
import { createForm, formNextField, formPrevField, formSetValue, formSubmit } from "./form"
import type { CommandArgSpec } from "../commands/types"

const specs: CommandArgSpec[] = [
  { name: "name", label: "Name", type: "string", required: true, style: "flag" },
  {
    name: "transport",
    label: "Transport",
    type: "enum",
    options: ["stdio", "http"],
    default: "stdio",
  },
  { name: "force", label: "Force", type: "boolean" },
]

describe("form state machine", () => {
  it("seeds field values from spec defaults", () => {
    const form = createForm(specs, "/mcp add", "mcp", "add")
    expect(form.commandName).toBe("mcp")
    expect(form.subcommand).toBe("add")
    expect(form.activeField).toBe(0)
    expect(form.fields.map((f) => f.value)).toEqual(["", "stdio", ""])
  })

  it("sets the active field's value and clears any error", () => {
    let form = createForm(specs, "t", "mcp", "add")
    form = { ...form, error: "boom" }
    form = formSetValue(form, "srv")
    expect(form.fields[0].value).toBe("srv")
    expect(form.error).toBeUndefined()
  })

  it("moves between fields with wrap-around", () => {
    let form = createForm(specs, "t", "mcp")
    form = formPrevField(form)
    expect(form.activeField).toBe(2)
    form = formNextField(form)
    expect(form.activeField).toBe(0)
    form = formNextField(form)
    expect(form.activeField).toBe(1)
  })

  it("blocks submission on a missing required field and focuses it", () => {
    const form = createForm(specs, "t", "mcp", "add")
    const result = formSubmit(form)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.form.error).toContain("Name")
      expect(result.form.activeField).toBe(0)
    }
  })

  it("builds the args string with flag, enum and boolean fields on submit", () => {
    let form = createForm(specs, "t", "mcp", "add")
    form = formSetValue(form, "srv") // name
    form = formNextField(form) // transport (default stdio)
    form = formNextField(form) // force
    form = formSetValue(form, "true")
    const result = formSubmit(form)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args).toBe("--name srv --transport stdio --force")
    }
  })
})
