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
          btn: { id: "btn", component: "Button", text: "Submit", action: "submit" },
        },
      },
    }
    renderInspector("sx", "btn")
    expect(screen.getByLabelText("text")).toHaveValue("Submit")
    expect(screen.getByLabelText("action")).toHaveValue("submit")
    expect(screen.getByText("btn")).toBeInTheDocument()
  })

  it("fires updateComponents when a text field changes", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          btn: { id: "btn", component: "Button", text: "Submit", action: "submit" },
        },
      },
    }
    renderInspector("sx", "btn")
    fireEvent.change(screen.getByLabelText("text"), { target: { value: "Send" } })
    expect(updateComponents).toHaveBeenCalledWith("sx", [
      expect.objectContaining({ id: "btn", component: "Button", text: "Send" }),
    ])
  })

  it("suggests data-model paths for a path-bound property", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        dataModel: { user: { name: "x" }, count: 5 },
        components: {
          btn: { id: "btn", component: "Button", text: "Submit", action: { path: "/user/name" } },
        },
      },
    }
    renderInspector("sx", "btn")
    const values = Array.from(document.querySelectorAll("datalist option")).map((o) =>
      o.getAttribute("value")
    )
    expect(values).toEqual(expect.arrayContaining(["/user", "/user/name", "/count"]))
  })

  it("discovers, sets, and clears optional enum properties with constrained choices", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          btn: { id: "btn", component: "Button", text: "Submit", action: "submit" },
        },
      },
    }
    const firstRender = renderInspector("sx", "btn")

    const variant = screen.getByRole("combobox", { name: "variant" })
    expect(variant).toHaveTextContent("Not set")
    fireEvent.click(variant)
    fireEvent.click(screen.getByRole("option", { name: "destructive" }))
    expect(updateComponents).toHaveBeenLastCalledWith("sx", [
      expect.objectContaining({ variant: "destructive" }),
    ])
    firstRender.unmount()

    updateComponents.mockClear()
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          btn: {
            id: "btn",
            component: "Button",
            text: "Submit",
            action: "submit",
            variant: "outline",
          },
        },
      },
    }
    renderInspector("sx", "btn")
    const configuredVariant = screen.getByRole("combobox", { name: "variant" })
    fireEvent.click(configuredVariant)
    fireEvent.click(screen.getByRole("option", { name: "Not set" }))
    expect(updateComponents).toHaveBeenCalledWith("sx", [
      { id: "btn", component: "Button", text: "Submit", action: "submit" },
    ])
  })

  it("does not let advanced JSON bypass enum constraints", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          btn: { id: "btn", component: "Button", text: "Submit", action: "submit" },
        },
      },
    }
    renderInspector("sx", "btn")

    fireEvent.change(screen.getByLabelText("Editable properties JSON"), {
      target: {
        value: '{"text":"Submit","action":"submit","variant":"rainbow"}',
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply property JSON" }))

    expect(screen.getByRole("alert")).toHaveTextContent("only editable properties")
    expect(updateComponents).not.toHaveBeenCalled()
  })

  it("edits path-bound and multiline properties without flattening their value types", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          note: {
            id: "note",
            component: "Text",
            text: { path: "/content/title" },
            description: "Long description",
          },
        },
      },
    }
    renderInspector("sx", "note")

    expect(screen.getByLabelText("text data path")).toHaveValue("/content/title")
    expect(screen.getByLabelText("description").tagName).toBe("TEXTAREA")
    fireEvent.change(screen.getByLabelText("text data path"), {
      target: { value: "/content/heading" },
    })
    expect(updateComponents).toHaveBeenCalledWith("sx", [
      expect.objectContaining({ text: { path: "/content/heading" } }),
    ])
  })

  it("validates structured property JSON before applying it", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          chart: {
            id: "chart",
            component: "Chart",
            chartType: "bar",
            data: [{ name: "A", value: 1 }],
          },
        },
      },
    }
    renderInspector("sx", "chart")

    const dataEditor = screen.getByLabelText("data JSON")
    fireEvent.change(dataEditor, { target: { value: "[" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply data" }))
    expect(screen.getByRole("alert")).toHaveTextContent("valid JSON")
    expect(updateComponents).not.toHaveBeenCalled()

    fireEvent.change(dataEditor, { target: { value: '[{"name":"B","value":2}]' } })
    fireEvent.click(screen.getByRole("button", { name: "Apply data" }))
    expect(updateComponents).toHaveBeenCalledWith("sx", [
      expect.objectContaining({ data: [{ name: "B", value: 2 }] }),
    ])
  })

  it("uses the advanced property object to add and remove optional properties safely", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          card: { id: "card", component: "Card", title: "Before", children: ["body"] },
          body: { id: "body", component: "Text", text: "Body" },
        },
      },
    }
    renderInspector("sx", "card")

    const editor = screen.getByLabelText("Editable properties JSON")
    fireEvent.change(editor, {
      target: { value: '{"description":"Added","className":"p-4"}' },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply property JSON" }))

    expect(updateComponents).toHaveBeenCalledWith("sx", [
      {
        id: "card",
        component: "Card",
        description: "Added",
        className: "p-4",
        children: ["body"],
      },
    ])
  })

  it("edits tab metadata without exposing or replacing child references", () => {
    storeState.surfaces = {
      sx: {
        rootId: "tabs",
        components: {
          tabs: {
            id: "tabs",
            component: "Tabs",
            tabs: [
              { id: "first", label: "First", children: ["body"] },
              { id: "empty", label: "Empty", children: [] },
            ],
          },
          body: { id: "body", component: "Text", text: "Body" },
        },
      },
    }
    renderInspector("sx", "tabs")

    const editor = screen.getByLabelText("tabs structural metadata JSON")
    expect(editor).not.toHaveValue(expect.stringContaining("children"))
    fireEvent.change(editor, {
      target: {
        value: JSON.stringify([
          { id: "new", label: "New" },
          { id: "first", label: "Renamed" },
        ]),
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply tabs structural metadata" }))

    expect(updateComponents).toHaveBeenCalledWith("sx", [
      expect.objectContaining({
        tabs: [
          { id: "new", label: "New", children: [] },
          { id: "first", label: "Renamed", children: ["body"] },
        ],
      }),
    ])
  })

  it("rejects removing a structural entry that still owns child references", () => {
    storeState.surfaces = {
      sx: {
        rootId: "accordion",
        components: {
          accordion: {
            id: "accordion",
            component: "Accordion",
            items: [{ id: "first", title: "First", children: ["body"] }],
          },
          body: { id: "body", component: "Text", text: "Body" },
        },
      },
    }
    renderInspector("sx", "accordion")

    fireEvent.change(screen.getByLabelText("items structural metadata JSON"), {
      target: { value: "[]" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply items structural metadata" }))

    expect(screen.getByRole("alert")).toHaveTextContent("child components")
    expect(updateComponents).not.toHaveBeenCalled()
  })

  it("edits List template dataPath while preserving the item component reference", () => {
    storeState.surfaces = {
      sx: {
        rootId: "list",
        components: {
          list: {
            id: "list",
            component: "List",
            template: { dataPath: "/rows", itemId: "row" },
          },
          row: { id: "row", component: "Text", text: { path: "/name" } },
        },
      },
    }
    renderInspector("sx", "list")

    const editor = screen.getByLabelText("template structural metadata JSON")
    expect(editor).not.toHaveValue(expect.stringContaining("itemId"))
    fireEvent.change(editor, { target: { value: '{"dataPath":"/results"}' } })
    fireEvent.click(screen.getByRole("button", { name: "Apply template structural metadata" }))

    expect(updateComponents).toHaveBeenCalledWith("sx", [
      expect.objectContaining({ template: { dataPath: "/results", itemId: "row" } }),
    ])
  })
})
