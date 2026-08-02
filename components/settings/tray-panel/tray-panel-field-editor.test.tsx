import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import type { TrayPanelField } from "@/lib/tray-panel/types"

import {
  TrayPanelFieldEditor,
  blankField,
  formatOptionLines,
  parseOptionLines,
} from "./tray-panel-field-editor"

describe("blankField", () => {
  it("picks an id that does not collide with existing ones", () => {
    expect(blankField("text", []).id).toBe("field1")
    expect(blankField("text", ["field1"]).id).toBe("field2")
    // The length-based seed can still land on a taken id — it must keep going.
    expect(blankField("text", ["field2"]).id).toBe("field3")
  })

  it("seeds each kind's required members", () => {
    const select = blankField("select", [])
    expect(select.kind).toBe("select")
    expect(select.kind === "select" && select.options.length).toBeGreaterThan(0)

    const sw = blankField("switch", [])
    expect(sw.kind === "switch" && sw.defaultValue).toBe(false)

    const textarea = blankField("textarea", [])
    expect(textarea.kind === "textarea" && textarea.rows).toBe(3)

    expect(blankField("number", []).kind).toBe("number")
    expect(blankField("text", []).kind).toBe("text")
  })
})

describe("option lines", () => {
  it("round-trips value=Label pairs", () => {
    const options = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "b" },
    ]
    expect(parseOptionLines(formatOptionLines(options))).toEqual(options)
  })

  it("treats a bare line as both value and label", () => {
    expect(parseOptionLines("solo")).toEqual([{ value: "solo", label: "solo" }])
  })

  it("trims, skips blank lines, and drops entries with no value", () => {
    expect(parseOptionLines("  a = Alpha \n\n =Nothing\n b ")).toEqual([
      { value: "a", label: "Alpha" },
      { value: "b", label: "b" },
    ])
  })

  it("keeps only the first = as the separator", () => {
    expect(parseOptionLines("a=x=y")).toEqual([{ value: "a", label: "x=y" }])
  })
})

describe("TrayPanelFieldEditor", () => {
  const fields: TrayPanelField[] = [{ kind: "text", id: "q", label: "Query" }]

  it("shows an empty state when the action collects nothing", () => {
    render(<TrayPanelFieldEditor fields={[]} onChange={jest.fn()} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("appends a field", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<TrayPanelFieldEditor fields={fields} onChange={onChange} />)

    await user.click(screen.getByRole("button", { name: "add" }))
    expect(onChange).toHaveBeenCalledWith([fields[0], expect.objectContaining({ kind: "text" })])
  })

  it("removes a field", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<TrayPanelFieldEditor fields={fields} onChange={onChange} />)

    await user.click(screen.getByRole("button", { name: "remove" }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("edits the id, which is how an effect references the value", () => {
    const onChange = jest.fn()
    render(<TrayPanelFieldEditor fields={fields} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText("id"), { target: { value: "query" } })
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: "query" })])
  })

  it("drops the i18n key when a built-in's label is edited", () => {
    // Keeping `labelKey` would make the translation win and the edit would
    // look like it never saved.
    const onChange = jest.fn()
    render(
      <TrayPanelFieldEditor
        fields={[{ kind: "text", id: "q", label: "Query", labelKey: "some.key" }]}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText("label"), { target: { value: "Mine" } })
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ label: "Mine", labelKey: undefined }),
    ])
  })

  it("rebuilds the field when its kind changes so no stale member survives", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <TrayPanelFieldEditor
        fields={[{ kind: "textarea", id: "q", label: "Query", rows: 9 }]}
        onChange={onChange}
      />
    )

    await user.click(screen.getByRole("combobox", { name: "kind" }))
    await user.click(await screen.findByRole("option", { name: "kinds.switch" }))

    const [next] = onChange.mock.calls.at(-1)![0] as TrayPanelField[]
    expect(next.kind).toBe("switch")
    expect(next.id).toBe("q")
    expect(next.label).toBe("Query")
    expect("rows" in next).toBe(false)
  })

  it("shows the options editor only for a dropdown", () => {
    const { rerender } = render(<TrayPanelFieldEditor fields={fields} onChange={jest.fn()} />)
    expect(screen.queryByLabelText("options")).not.toBeInTheDocument()

    rerender(
      <TrayPanelFieldEditor
        fields={[{ kind: "select", id: "s", label: "S", options: [{ value: "a", label: "A" }] }]}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByLabelText("options")).toHaveValue("a=A")
  })

  it("parses edited option lines", () => {
    const onChange = jest.fn()
    render(
      <TrayPanelFieldEditor
        fields={[{ kind: "select", id: "s", label: "S", options: [] }]}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText("options"), { target: { value: "x=Ex\ny" } })
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        options: [
          { value: "x", label: "Ex" },
          { value: "y", label: "y" },
        ],
      }),
    ])
  })

  it("toggles required", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<TrayPanelFieldEditor fields={fields} onChange={onChange} />)

    await user.click(screen.getByRole("switch", { name: "required" }))
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ required: true })])
  })

  it("offers Enter-submits only on a long-text field", () => {
    const { rerender } = render(<TrayPanelFieldEditor fields={fields} onChange={jest.fn()} />)
    expect(screen.queryByRole("switch", { name: "submitOnEnter" })).not.toBeInTheDocument()

    rerender(
      <TrayPanelFieldEditor
        fields={[{ kind: "textarea", id: "p", label: "P" }]}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByRole("switch", { name: "submitOnEnter" })).toBeInTheDocument()
  })

  it("flags an invalid id for assistive tech", () => {
    render(
      <TrayPanelFieldEditor fields={fields} onChange={jest.fn()} invalidIds={new Set(["q"])} />
    )
    expect(screen.getByLabelText("id")).toHaveAttribute("aria-invalid", "true")
  })
})
