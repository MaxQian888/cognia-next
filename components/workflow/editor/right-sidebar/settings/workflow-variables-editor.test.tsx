/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { WorkflowVariablesEditor } from "./workflow-variables-editor"

const messages = {
  workflowEditor: {
    settings: {
      variables: {
        addButton: "Add variable",
        keyPlaceholder: "KEY",
        valuePlaceholder: "value",
        removeAria: "Remove variable",
        invalidKey: "Invalid identifier",
        duplicateKey: "Duplicate key",
        empty: "No variables yet.",
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

describe("WorkflowVariablesEditor", () => {
  it("renders the empty state with no variables", () => {
    wrap(<WorkflowVariablesEditor value={{}} onChange={jest.fn()} />)
    expect(screen.getByText("No variables yet.")).toBeInTheDocument()
  })

  it("adds a row when 'Add variable' is clicked", () => {
    const onChange = jest.fn()
    wrap(<WorkflowVariablesEditor value={{}} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("wf-var-add"))
    // Empty key isn't committed yet, so the map is still empty.
    expect(onChange).toHaveBeenCalledWith({})
  })

  it("commits a key/value pair", () => {
    const onChange = jest.fn()
    wrap(<WorkflowVariablesEditor value={{ API_BASE: "https://x" }} onChange={onChange} />)
    fireEvent.change(screen.getByTestId("wf-var-value-0"), { target: { value: "https://y" } })
    expect(onChange).toHaveBeenCalledWith({ API_BASE: "https://y" })
  })

  it("flags an invalid identifier key via aria-invalid", () => {
    wrap(<WorkflowVariablesEditor value={{ "1bad": "x" }} onChange={jest.fn()} />)
    expect(screen.getByTestId("wf-var-key-0")).toHaveAttribute("aria-invalid", "true")
  })

  it("removes a row", () => {
    const onChange = jest.fn()
    wrap(<WorkflowVariablesEditor value={{ A: "1", B: "2" }} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("wf-var-remove-0"))
    expect(onChange).toHaveBeenCalledWith({ B: "2" })
  })
})
