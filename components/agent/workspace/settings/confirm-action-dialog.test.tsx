/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { ConfirmActionDialog } from "./confirm-action-dialog"

// Radix AlertDialog uses pointer-capture APIs jsdom lacks; stub to plain DOM.
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button onClick={onClick} disabled={disabled} data-testid="confirm-action">
      {children}
    </button>
  ),
}))

describe("ConfirmActionDialog", () => {
  const base = {
    open: true,
    onOpenChange: jest.fn(),
    title: "Delete team?",
    description: "This cannot be undone.",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
  }

  it("renders title + description when open", () => {
    render(<ConfirmActionDialog {...base} onConfirm={jest.fn()} />)
    expect(screen.getByText("Delete team?")).toBeInTheDocument()
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument()
  })

  it("fires onConfirm when the confirm button is clicked (no type guard)", () => {
    const onConfirm = jest.fn()
    render(<ConfirmActionDialog {...base} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId("confirm-action"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("keeps confirm disabled until the type-to-confirm text matches", () => {
    const onConfirm = jest.fn()
    render(<ConfirmActionDialog {...base} typeToConfirm="My Team" onConfirm={onConfirm} />)
    const confirm = screen.getByTestId("confirm-action") as HTMLButtonElement
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByTestId("confirm-type-to-confirm"), {
      target: { value: "wrong" },
    })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByTestId("confirm-type-to-confirm"), {
      target: { value: "My Team" },
    })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
