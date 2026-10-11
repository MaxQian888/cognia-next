import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TRAY_TITLE_MAX_FIELDS, type TrayTitleField } from "@/lib/tray/title-format"

import { addableField, TrayTitleFieldsEditor } from "./tray-title-fields-editor"

// jsdom has no pointer capture; Radix Select and DropdownMenu ask for it.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
})

const FIELDS: TrayTitleField[] = [
  { kind: "usage", period: "1d", metric: "tokens" },
  { kind: "running" },
  { kind: "awaiting" },
]

function setup(fields: TrayTitleField[] = FIELDS, preview: string | null = "1D 3M · ▶2") {
  const onChange = jest.fn()
  render(<TrayTitleFieldsEditor fields={fields} onChange={onChange} preview={preview} />)
  return onChange
}

describe("addableField", () => {
  it("offers a kind once, and the first unused usage window", () => {
    expect(addableField(FIELDS, "running")).toBeNull()
    expect(addableField(FIELDS, "quota")).toEqual({ kind: "quota" })
    expect(addableField(FIELDS, "usage")).toEqual({ kind: "usage", period: "7d", metric: "tokens" })
  })

  it("runs out of usage fields once every window and metric is shown", () => {
    const all: TrayTitleField[] = (["tokens", "spend"] as const).flatMap((metric) =>
      (["1d", "7d", "30d"] as const).map((period) => ({ kind: "usage" as const, period, metric }))
    )
    expect(addableField(all.slice(0, 5), "usage")).toEqual({
      kind: "usage",
      period: "30d",
      metric: "spend",
    })
  })

  it("offers nothing at the cap", () => {
    const full: TrayTitleField[] = [
      { kind: "running" },
      { kind: "awaiting" },
      { kind: "quota" },
      { kind: "budget" },
      { kind: "usage", period: "1d", metric: "tokens" },
      { kind: "usage", period: "7d", metric: "tokens" },
    ]
    expect(full).toHaveLength(TRAY_TITLE_MAX_FIELDS)
    expect(addableField(full, "usage")).toBeNull()
  })
})

describe("TrayTitleFieldsEditor", () => {
  it("lists the fields in order with the live title underneath", () => {
    setup()
    const rows = within(screen.getByRole("list")).getAllByRole("listitem")
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "tray-title-field-usage:1d:tokens",
      "tray-title-field-running",
      "tray-title-field-awaiting",
    ])
    expect(screen.getByTestId("tray-title-preview")).toHaveTextContent("Now: 1D 3M · ▶2")
  })

  it("says when nothing would show right now", () => {
    setup(FIELDS, null)
    expect(screen.getByTestId("tray-title-preview")).toHaveTextContent("Nothing to show right now")
  })

  it("says the title stays blank with no fields", () => {
    setup([])
    expect(screen.getByTestId("tray-title-fields-empty")).toBeInTheDocument()
  })

  it("moves a field and disables moves past the ends", async () => {
    const onChange = setup()
    expect(screen.getByRole("button", { name: "Move Tokens · Today up" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Move Awaiting approval down" })).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "Move Running tasks up" }))
    expect(onChange).toHaveBeenLastCalledWith([FIELDS[1], FIELDS[0], FIELDS[2]])
  })

  it("removes a field", async () => {
    const onChange = setup()
    await userEvent.click(screen.getByRole("button", { name: "Remove Running tasks" }))
    expect(onChange).toHaveBeenLastCalledWith([FIELDS[0], FIELDS[2]])
  })

  it("adds a field the title does not show yet", async () => {
    const onChange = setup()
    await userEvent.click(screen.getByTestId("tray-title-add"))
    expect(screen.queryByRole("menuitem", { name: "Running tasks" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("menuitem", { name: "Quota used" }))
    expect(onChange).toHaveBeenLastCalledWith([...FIELDS, { kind: "quota" }])
  })

  it("changes a usage field's window", async () => {
    const onChange = setup()
    await userEvent.click(screen.getByRole("combobox", { name: "Window for Tokens · Today" }))
    await userEvent.click(screen.getByRole("option", { name: "7 days" }))
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "usage", period: "7d", metric: "tokens" },
      FIELDS[1],
      FIELDS[2],
    ])
  })

  it("collapses two usage rows that became the same field", async () => {
    const onChange = setup([
      { kind: "usage", period: "1d", metric: "tokens" },
      { kind: "usage", period: "7d", metric: "tokens" },
    ])
    await userEvent.click(screen.getByRole("combobox", { name: "Window for Tokens · 7 days" }))
    await userEvent.click(screen.getByRole("option", { name: "Today" }))
    expect(onChange).toHaveBeenLastCalledWith([{ kind: "usage", period: "1d", metric: "tokens" }])
  })

  it("disables adding at the cap and says why", () => {
    setup([
      { kind: "running" },
      { kind: "awaiting" },
      { kind: "quota" },
      { kind: "budget" },
      { kind: "usage", period: "1d", metric: "tokens" },
      { kind: "usage", period: "7d", metric: "tokens" },
    ])
    expect(screen.getByTestId("tray-title-add")).toBeDisabled()
    expect(screen.getByText(`Up to ${TRAY_TITLE_MAX_FIELDS} fields`)).toBeInTheDocument()
  })
})
