/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { IdentitySection } from "./identity-section"
import { emptyEditorState } from "../preset-editor-state"

describe("IdentitySection", () => {
  it("renders name, description, category, icon, and color palette", () => {
    render(<IdentitySection state={emptyEditorState()} onPatch={jest.fn()} />)
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Description")).toBeInTheDocument()
    expect(screen.getByText("Category")).toBeInTheDocument()
    const swatches = screen.getAllByRole("button", { name: /Pick color/ })
    expect(swatches).toHaveLength(12)
  })

  it("invokes onPatch when the name field changes", () => {
    const onPatch = jest.fn()
    render(<IdentitySection state={emptyEditorState()} onPatch={onPatch} />)
    fireEvent.change(screen.getByPlaceholderText("Code Reviewer"), {
      target: { value: "Refactor Reviewer" },
    })
    expect(onPatch).toHaveBeenCalledWith({ name: "Refactor Reviewer" })
  })

  it("invokes onPatch when the description field changes", () => {
    const onPatch = jest.fn()
    render(<IdentitySection state={emptyEditorState()} onPatch={onPatch} />)
    fireEvent.change(screen.getByPlaceholderText("(optional) one-line summary"), {
      target: { value: "spots refactor opportunities" },
    })
    expect(onPatch).toHaveBeenCalledWith({ description: "spots refactor opportunities" })
  })

  it("invokes onPatch when the icon field changes", () => {
    const onPatch = jest.fn()
    render(<IdentitySection state={emptyEditorState()} onPatch={onPatch} />)
    fireEvent.change(screen.getByLabelText("Icon emoji"), { target: { value: "🔧" } })
    expect(onPatch).toHaveBeenCalledWith({ icon: "🔧" })
  })

  it("invokes onPatch with the picked color when a swatch is clicked", () => {
    const onPatch = jest.fn()
    render(<IdentitySection state={emptyEditorState()} onPatch={onPatch} />)
    const swatches = screen.getAllByRole("button", { name: /Pick color/ })
    fireEvent.click(swatches[3])
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch.mock.calls[0][0]).toHaveProperty("color")
    expect(typeof onPatch.mock.calls[0][0].color).toBe("string")
  })
})
