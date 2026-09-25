/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"

import enMessages from "@/i18n/messages/en.json"

import { ToolPicker } from "./tool-picker"

// Real catalog, not a hand-written stub: the stub in leaf-components.test.tsx
// carried `scheduler.tools.*` keys the shipped messages did not, so the
// picker rendered raw key paths in the app while every test passed.
function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function Harness({ initial }: { initial?: string[] }) {
  const [value, setValue] = useState<string[] | undefined>(initial)
  return <ToolPicker value={value} onChange={setValue} testId="tp" />
}

describe("ToolPicker", () => {
  it("labels the custom-tool field and ties the label to the input", () => {
    renderWithIntl(<Harness />)
    const input = screen.getByLabelText("Add a tool by name")
    expect(input).toBe(screen.getByTestId("tp-add-input"))
    expect(input).toHaveAttribute("placeholder", "mcp__server__tool")
    expect(screen.getByTestId("tp-add-button")).toHaveTextContent("Add")
  })

  it("adds a typed tool on Enter and lists it under custom tools", () => {
    renderWithIntl(<Harness />)
    const input = screen.getByLabelText("Add a tool by name")
    fireEvent.change(input, { target: { value: "mcp__github__search" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByText("Custom tools")).toBeInTheDocument()
    expect(screen.getByTestId("tp-custom-mcp__github__search")).toBeInTheDocument()
    expect(input).toHaveValue("")
  })

  it("names the tool each remove button removes", () => {
    renderWithIntl(<Harness initial={["mcp__a__x", "mcp__b__y"]} />)
    fireEvent.click(screen.getByRole("button", { name: "Remove mcp__a__x" }))
    expect(screen.queryByTestId("tp-custom-mcp__a__x")).not.toBeInTheDocument()
    expect(screen.getByTestId("tp-custom-mcp__b__y")).toBeInTheDocument()
  })
})
