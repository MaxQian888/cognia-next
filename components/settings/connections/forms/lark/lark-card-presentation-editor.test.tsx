/** @jest-environment jsdom */
import { useState } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { LarkCardPresentationEditor } from "./lark-card-presentation-editor"
import { normalizeLarkCardPresentation } from "@/lib/connectors/adapters/lark/card-presentation"

it("edits a title and visibility, then resets all preferences", () => {
  function Harness() {
    const [value, setValue] = useState(
      normalizeLarkCardPresentation({ title: "Release", showElapsed: false })
    )
    return <LarkCardPresentationEditor value={value} onChange={setValue} />
  }
  render(<Harness />)
  expect(screen.getByRole("switch", { name: "Show elapsed time" })).not.toBeChecked()
  fireEvent.click(screen.getByRole("switch", { name: "Show elapsed time" }))
  expect(screen.getByRole("switch", { name: "Show elapsed time" })).toBeChecked()
  fireEvent.change(screen.getByRole("textbox", { name: "Custom card title" }), {
    target: { value: "Build" },
  })
  expect(screen.getByRole("textbox", { name: "Custom card title" })).toHaveValue("Build")
  fireEvent.click(screen.getByRole("button", { name: "Reset card appearance" }))
  expect(screen.getByRole("textbox", { name: "Custom card title" })).toHaveValue("")
  expect(screen.getByRole("combobox", { name: "Header color" })).toHaveTextContent("Follow status")
})

it("disables editing and reset while settings are being saved", () => {
  const change = jest.fn()
  render(
    <LarkCardPresentationEditor
      value={normalizeLarkCardPresentation({})}
      onChange={change}
      disabled
    />
  )
  for (const field of [
    ...screen.getAllByRole("combobox"),
    ...screen.getAllByRole("switch"),
    ...screen.getAllByRole("textbox"),
  ])
    expect(field).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Reset card appearance" }))
  expect(change).not.toHaveBeenCalled()
})

it("validates template opt-in and supports disabling it without losing entered values", () => {
  function Harness() {
    const [value, setValue] = useState(normalizeLarkCardPresentation({}))
    return <LarkCardPresentationEditor value={value} onChange={setValue} />
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a template for successful replies" }))
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a template ID")
  fireEvent.change(screen.getByRole("textbox", { name: "Template ID" }), {
    target: { value: "AA_template" },
  })
  fireEvent.change(screen.getByRole("textbox", { name: "Published template version" }), {
    target: { value: "1.0.0" },
  })
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("switch", { name: "Use a template for successful replies" }))
  expect(screen.queryByRole("textbox", { name: "Template ID" })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("switch", { name: "Use a template for successful replies" }))
  expect(screen.getByRole("textbox", { name: "Template ID" })).toHaveValue("AA_template")
})
