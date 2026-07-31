/**
 * Tests for the workspace data-model panel.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const setDataValue = jest.fn()
const updateDataModel = jest.fn()
const storeState: {
  surfaces: Record<string, unknown>
  setDataValue: typeof setDataValue
  updateDataModel: typeof updateDataModel
} = {
  surfaces: {},
  setDataValue,
  updateDataModel,
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { DataModelPanel } from "./data-model-panel"

function renderPanel(surfaceId = "sx") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <A2UIWorkspaceProvider surfaceId={surfaceId}>
        <DataModelPanel />
      </A2UIWorkspaceProvider>
    </NextIntlClientProvider>
  )
}

describe("DataModelPanel", () => {
  beforeEach(() => {
    setDataValue.mockReset()
    updateDataModel.mockReset()
    storeState.surfaces = {}
  })

  it("renders the no-surface fallback when the surface is missing", () => {
    renderPanel("missing")
    expect(screen.getByText(/no surface loaded/i)).toBeInTheDocument()
  })

  it("shows the empty data-model state when there are no keys", () => {
    storeState.surfaces = { sx: { dataModel: {} } }
    renderPanel()
    expect(screen.getByText(/empty data model/i)).toBeInTheDocument()
  })

  it("renders every top-level key of the data model", () => {
    storeState.surfaces = {
      sx: {
        dataModel: {
          name: "Alice",
          count: 3,
          done: true,
        },
      },
    }
    renderPanel()
    expect(screen.getByText("name")).toBeInTheDocument()
    expect(screen.getByText("count")).toBeInTheDocument()
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.getByText("3 keys")).toBeInTheDocument()
  })

  it("atomically replaces the data model when a value is edited", () => {
    storeState.surfaces = {
      sx: {
        dataModel: { name: "Alice" },
      },
    }
    renderPanel()
    // Double-click the row to enter edit mode
    fireEvent.doubleClick(screen.getByText("name").closest("div") as HTMLElement)
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: '"Bob"' } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(updateDataModel).toHaveBeenCalledWith("sx", { name: "Bob" }, false)
  })

  it("encodes special object keys when editing nested values", () => {
    storeState.surfaces = {
      sx: {
        dataModel: { "profile/name": { "~label": "Alice" } },
      },
    }
    renderPanel()

    fireEvent.click(screen.getByRole("button", { name: "Expand /profile~1name" }))
    fireEvent.doubleClick(screen.getByText("~label").closest("div") as HTMLElement)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: '"Bob"' } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(updateDataModel).toHaveBeenCalledWith(
      "sx",
      { "profile/name": { "~label": "Bob" } },
      false
    )
  })

  it("adds object keys and appends array entries through the shared path primitives", () => {
    storeState.surfaces = { sx: { dataModel: { items: ["first"] } } }
    renderPanel()

    fireEvent.click(screen.getByRole("button", { name: "Add root data entry" }))
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "enabled" } })
    fireEvent.change(screen.getByLabelText("Value JSON"), { target: { value: "true" } })
    fireEvent.click(screen.getByRole("button", { name: "Add data entry" }))
    expect(updateDataModel).toHaveBeenLastCalledWith(
      "sx",
      { items: ["first"], enabled: true },
      false
    )

    updateDataModel.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Add data entry at /items" }))
    expect(screen.queryByLabelText("Key")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Value JSON"), { target: { value: '"second"' } })
    fireEvent.click(screen.getByRole("button", { name: "Append data entry" }))
    expect(updateDataModel).toHaveBeenCalledWith("sx", { items: ["first", "second"] }, false)
  })

  it("edits object structure as JSON and rejects invalid or unsafe models", () => {
    storeState.surfaces = { sx: { dataModel: { settings: { theme: "light" } } } }
    renderPanel()

    fireEvent.doubleClick(screen.getByText("settings").closest("div") as HTMLElement)
    const nodeEditor = screen.getByLabelText("Edit value at /settings")
    fireEvent.change(nodeEditor, { target: { value: "{" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply value at /settings" }))
    expect(screen.getByRole("alert")).toHaveTextContent("valid JSON")
    expect(updateDataModel).not.toHaveBeenCalled()

    fireEvent.change(nodeEditor, { target: { value: '{"theme":"dark","dense":true}' } })
    fireEvent.click(screen.getByRole("button", { name: "Apply value at /settings" }))
    expect(updateDataModel).toHaveBeenCalledWith(
      "sx",
      { settings: { theme: "dark", dense: true } },
      false
    )

    updateDataModel.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Edit complete data model JSON" }))
    const modelEditor = screen.getByLabelText("Complete data model JSON")
    fireEvent.change(modelEditor, {
      target: { value: '{"__proto__":{"polluted":true}}' },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply complete data model JSON" }))
    expect(screen.getByRole("alert")).toHaveTextContent("safe JSON object")
    expect(updateDataModel).not.toHaveBeenCalled()
  })

  it("confirms deletion and compacts arrays without mutating the current model", () => {
    storeState.surfaces = { sx: { dataModel: { items: ["first", "second"] } } }
    renderPanel()

    fireEvent.click(screen.getByRole("button", { name: "Expand /items" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete value at /items/0" }))
    expect(screen.getByText("Delete data value?")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(updateDataModel).toHaveBeenCalledWith("sx", { items: ["second"] }, false)
    expect((storeState.surfaces.sx as { dataModel: unknown }).dataModel).toEqual({
      items: ["first", "second"],
    })
  })
})
