/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { MultiEntityPicker } from "./multi-entity-picker"

const messages = {
  workflows: {
    forms: {
      pickers: {
        noResults: "No results",
        remove: "Remove {name}",
        addLiteral: "Use “{value}”",
      },
    },
  },
}

const OPTIONS = [
  { value: "Read", label: "Read" },
  { value: "Bash", label: "Bash" },
]

function renderPicker(value: string[] = []) {
  const onChange = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MultiEntityPicker
        id="tools"
        value={value}
        onChange={onChange}
        options={OPTIONS}
        placeholder="Add a tool"
        emptyHint="Nothing selected"
      />
    </NextIntlClientProvider>
  )
  return onChange
}

describe("MultiEntityPicker", () => {
  it("renders the empty hint before anything is chosen", () => {
    renderPicker()
    expect(screen.getByText("Nothing selected")).toBeInTheDocument()
  })

  it("renders one removable chip per selected value", () => {
    const onChange = renderPicker(["Read", "Bash"])
    expect(screen.getByTestId("tools-chip-Read")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("tools-remove-Read"))
    expect(onChange).toHaveBeenCalledWith(["Bash"])
  })

  it("appends a value picked from the registry", () => {
    const onChange = renderPicker([])
    fireEvent.click(screen.getByTestId("tools-add"))
    fireEvent.click(screen.getByText("Bash"))
    expect(onChange).toHaveBeenCalledWith(["Bash"])
  })

  it("keeps free entry, because none of these registries is a closed set", () => {
    // A plugin tool the host has not loaded yet is still a legal id, and the
    // comma-separated `<Input>` this replaced accepted anything.
    const onChange = renderPicker([])
    fireEvent.click(screen.getByTestId("tools-add"))
    fireEvent.change(screen.getByPlaceholderText("Add a tool"), {
      target: { value: "mcp__thing__do" },
    })
    fireEvent.click(screen.getByTestId("tools-add-free"))
    expect(onChange).toHaveBeenCalledWith(["mcp__thing__do"])
  })

  it("does not offer a value that is already selected", () => {
    renderPicker(["Bash"])
    fireEvent.click(screen.getByTestId("tools-add"))
    expect(screen.queryByText("Bash")).not.toBe(screen.getByTestId("tools-chip-Bash"))
  })
})
