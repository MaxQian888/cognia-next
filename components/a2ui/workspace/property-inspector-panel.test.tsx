/**
 * Tests for the workspace property inspector.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const updateComponents = jest.fn()
const storeState: {
  surfaces: Record<string, unknown>
  updateComponents: typeof updateComponents
} = {
  surfaces: {},
  updateComponents,
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { A2UIWorkspaceProvider, useWorkspaceContext } from "./a2ui-workspace-context"
import { PropertyInspectorPanel } from "./property-inspector-panel"

function Harness({ selectId }: { selectId?: string }) {
  const { setSelectedComponentId } = useWorkspaceContext()
  React.useEffect(() => {
    if (selectId) setSelectedComponentId(selectId)
  }, [selectId, setSelectedComponentId])
  return <PropertyInspectorPanel />
}

function renderInspector(surfaceId = "sx", selectId?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <A2UIWorkspaceProvider surfaceId={surfaceId}>
        <Harness selectId={selectId} />
      </A2UIWorkspaceProvider>
    </NextIntlClientProvider>
  )
}

describe("PropertyInspectorPanel", () => {
  beforeEach(() => {
    updateComponents.mockReset()
    storeState.surfaces = {}
  })

  it("renders the empty-selection state when nothing is selected", () => {
    renderInspector()
    expect(screen.getByText(/no component selected/i)).toBeInTheDocument()
  })

  it("renders type-specific fields for the selected component", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          btn: { id: "btn", component: "Button", label: "Submit" },
        },
      },
    }
    renderInspector("sx", "btn")
    // Button schema includes Label, Action, Disabled, Variant
    expect(screen.getByText(/Label/i)).toBeInTheDocument()
    expect(screen.getByText(/Action/i)).toBeInTheDocument()
    expect(screen.getByText(/Disabled/i)).toBeInTheDocument()
  })

  it("fires updateComponents when a text field changes", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          btn: { id: "btn", component: "Button", label: "Submit" },
        },
      },
    }
    renderInspector("sx", "btn")
    // Find the input bound to the Label field; first text input visible
    const inputs = screen
      .getAllByRole("textbox")
      .filter((el) => (el as HTMLInputElement).type !== "number")
    const labelInput = inputs[0] as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: "Send" } })
    expect(updateComponents).toHaveBeenCalled()
  })
})
