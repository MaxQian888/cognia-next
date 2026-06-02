/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { DataPanel } from "./data-panel"

function renderPanel(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("DataPanel", () => {
  it("shows the empty state with a Run CTA when there is no data", () => {
    const onRunStep = jest.fn()
    renderPanel(
      <DataPanel sourceNodeId="n_a" value={undefined} source="none" onRunStep={onRunStep} />
    )
    expect(screen.getByTestId("data-panel-empty")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Run this step" }))
    expect(onRunStep).toHaveBeenCalled()
  })

  it("renders the Table view by default and toggles to JSON / Schema", () => {
    renderPanel(<DataPanel sourceNodeId="n_a" value={{ completion: "hi", n: 1 }} source="run" />)
    expect(screen.getByTestId("data-table-view")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("radio", { name: "JSON" }))
    expect(screen.getByTestId("data-json-view")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("radio", { name: "Schema" }))
    expect(screen.getByTestId("data-schema-view")).toBeInTheDocument()
  })

  it("pages through array items", () => {
    renderPanel(
      <DataPanel sourceNodeId="n_a" value={[{ id: 1 }, { id: 2 }, { id: 3 }]} source="run" />
    )
    expect(screen.getByTestId("item-nav-label")).toHaveTextContent("Item 1 / 3")
    fireEvent.click(screen.getByRole("button", { name: "Next item" }))
    expect(screen.getByTestId("item-nav-label")).toHaveTextContent("Item 2 / 3")
  })

  it("shows the Pinned badge and Unpin button when pinned, and pins on click", () => {
    const onPin = jest.fn()
    const onUnpin = jest.fn()
    const { rerender } = renderPanel(
      <DataPanel
        sourceNodeId="n_a"
        value={{ a: 1 }}
        source="run"
        pin={{ pinned: false, onPin, onUnpin }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Pin output" }))
    expect(onPin).toHaveBeenCalledWith({ a: 1 })

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DataPanel
          sourceNodeId="n_a"
          value={{ a: 1 }}
          source="pin"
          pin={{ pinned: true, onPin, onUnpin }}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("pinned-badge")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }))
    expect(onUnpin).toHaveBeenCalled()
  })

  it("renders a single value row for a primitive output", () => {
    renderPanel(<DataPanel sourceNodeId="n_a" value={"hello"} source="run" />)
    expect(screen.getByTestId("data-table-view")).toBeInTheDocument()
    expect(screen.getByText("value")).toBeInTheDocument()
  })

  it("edit-fixture: invalid JSON does not pin; valid JSON pins the parsed value", () => {
    const onPin = jest.fn()
    renderPanel(
      <DataPanel
        sourceNodeId="n_a"
        value={{ a: 1 }}
        source="run"
        pin={{ pinned: false, onPin, onUnpin: jest.fn() }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit fixture" }))
    const textarea = screen.getByLabelText("Edit fixture")

    fireEvent.change(textarea, { target: { value: "{not json" } })
    fireEvent.click(screen.getByRole("button", { name: "Save fixture" }))
    expect(onPin).not.toHaveBeenCalled()

    fireEvent.change(textarea, { target: { value: '{"b":2}' } })
    fireEvent.click(screen.getByRole("button", { name: "Save fixture" }))
    expect(onPin).toHaveBeenCalledWith({ b: 2 })
  })

  it("edit-fixture: cancel restores the data view", () => {
    renderPanel(
      <DataPanel
        sourceNodeId="n_a"
        value={{ a: 1 }}
        source="run"
        pin={{ pinned: false, onPin: jest.fn(), onUnpin: jest.fn() }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit fixture" }))
    expect(screen.getByLabelText("Edit fixture")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByLabelText("Edit fixture")).toBeNull()
    expect(screen.getByTestId("data-panel")).toBeInTheDocument()
  })

  it("exposes draggable field rows carrying the expression payload", () => {
    renderPanel(<DataPanel sourceNodeId="n_a" value={{ completion: "hi" }} source="run" />)
    const row = screen.getAllByTestId("data-field-row")[0]
    expect(row).toHaveAttribute("draggable", "true")

    const setData = jest.fn()
    fireEvent.dragStart(row, { dataTransfer: { setData } })
    expect(setData).toHaveBeenCalledWith(
      "application/x-workflow-expr",
      JSON.stringify({ nodeId: "n_a", segments: ["completion"] })
    )
  })
})
