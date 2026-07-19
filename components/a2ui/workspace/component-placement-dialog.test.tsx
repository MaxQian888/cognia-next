import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { ComponentPlacementDialog } from "./component-placement-dialog"

const components = {
  root: { id: "root", component: "Column", children: ["first", "second"] },
  first: { id: "first", component: "Text", text: "First" },
  second: { id: "second", component: "Text", text: "Second" },
} as Record<string, A2UIComponent>

function renderDialog(props: Partial<React.ComponentProps<typeof ComponentPlacementDialog>> = {}) {
  const onAdd = jest.fn(() => true)
  const onMove = jest.fn(() => true)
  const onAddToRoot = jest.fn(() => true)
  const onOpenChange = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <ComponentPlacementDialog
        mode="add"
        components={components}
        componentTypes={["Text", "Button", "Card"]}
        onAdd={onAdd}
        onAddToRoot={onAddToRoot}
        onMove={onMove}
        onOpenChange={onOpenChange}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { onAdd, onAddToRoot, onMove, onOpenChange }
}

describe("ComponentPlacementDialog", () => {
  it("filters catalog types and submits an explicit add placement", () => {
    const { onAdd, onOpenChange } = renderDialog()

    fireEvent.change(screen.getByLabelText("Component type"), { target: { value: "but" } })
    expect(screen.queryByRole("button", { name: "Text" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Button" }))
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "1" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    expect(onAdd).toHaveBeenCalledWith("Button", {
      parentId: "root",
      slotId: "/children",
      index: 1,
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("submits a move by final position and excludes descendant destinations", () => {
    const { onMove } = renderDialog({ mode: "move", componentId: "first" })

    expect(screen.queryByLabelText("Component type")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "1" } })
    fireEvent.click(screen.getByRole("button", { name: "Move" }))

    expect(onMove).toHaveBeenCalledWith({
      parentId: "root",
      slotId: "/children",
      index: 1,
    })
  })

  it("keeps the dialog open and surfaces an atomic mutation failure", () => {
    const onMove = jest.fn(() => false)
    const onOpenChange = jest.fn()
    renderDialog({ mode: "move", componentId: "first", onMove, onOpenChange })

    fireEvent.click(screen.getByRole("button", { name: "Move" }))

    expect(screen.getByRole("alert")).toHaveTextContent("The component change could not be applied")
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("offers atomic root wrapping when a leaf surface has no collection slots", () => {
    const onAddToRoot = jest.fn(() => true)
    renderDialog({
      components: { leaf: { id: "leaf", component: "Text", text: "Leaf" } },
      componentTypes: ["Card"],
      onAddToRoot,
    })

    expect(screen.queryByLabelText("Position")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(onAddToRoot).toHaveBeenCalledWith("Card")
  })
})
