/**
 * RenameDialog - Unit Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RenameDialog } from "./rename-dialog"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      renameDocument: "Rename Document",
      documentTitle: "Document Title",
      cancel: "Cancel",
      save: "Save",
    }
    return translations[key] || key
  },
}))

describe("RenameDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    currentTitle: "Test Document",
    onRename: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render when open is true", () => {
    render(<RenameDialog {...defaultProps} />)
    expect(screen.getByText("Rename Document")).toBeInTheDocument()
  })

  it("should display current title in input", () => {
    render(<RenameDialog {...defaultProps} />)
    const input = screen.getByPlaceholderText("Document Title")
    expect(input).toHaveValue("Test Document")
  })

  it("should call onOpenChange when cancel is clicked", async () => {
    render(<RenameDialog {...defaultProps} />)
    const cancelButton = screen.getByText("Cancel")
    await userEvent.click(cancelButton)
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("should call onRename with current title when save is clicked", async () => {
    render(<RenameDialog {...defaultProps} />)

    const saveButton = screen.getByText("Save")
    await userEvent.click(saveButton)

    expect(defaultProps.onRename).toHaveBeenCalledWith("Test Document")
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("should disable save button when input is empty", async () => {
    render(<RenameDialog {...defaultProps} currentTitle="" />)

    const saveButton = screen.getByText("Save")
    expect(saveButton).toBeDisabled()
  })

  it("should disable save button when input has only whitespace", async () => {
    render(<RenameDialog {...defaultProps} currentTitle="   " />)

    const saveButton = screen.getByText("Save")
    expect(saveButton).toBeDisabled()
  })

  it("should call onRename when Enter key is pressed", async () => {
    render(<RenameDialog {...defaultProps} />)
    const input = screen.getByPlaceholderText("Document Title")

    await userEvent.type(input, "{enter}")

    expect(defaultProps.onRename).toHaveBeenCalledWith("Test Document")
  })

  it("should trim whitespace from title", async () => {
    render(<RenameDialog {...defaultProps} currentTitle="  Trimmed Title  " />)

    const saveButton = screen.getByText("Save")
    await userEvent.click(saveButton)

    expect(defaultProps.onRename).toHaveBeenCalledWith("Trimmed Title")
  })

  it("should not render when open is false", () => {
    render(<RenameDialog {...defaultProps} open={false} />)
    expect(screen.queryByText("Rename Document")).not.toBeInTheDocument()
  })
})
