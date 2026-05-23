/**
 * Tests for the workspace data-model panel.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const setDataValue = jest.fn()
const storeState: {
  surfaces: Record<string, unknown>
  setDataValue: typeof setDataValue
} = {
  surfaces: {},
  setDataValue,
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

  it("calls setDataValue with the JSON pointer path when a value is edited", () => {
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
    expect(setDataValue).toHaveBeenCalledWith("sx", "/name", "Bob")
  })
})
