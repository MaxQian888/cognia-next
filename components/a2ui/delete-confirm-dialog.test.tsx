/**
 * Tests for DeleteConfirmDialog
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { DeleteConfirmDialog } from "./delete-confirm-dialog"

const mockButtonVariants = jest.fn((options?: { variant?: string; className?: string }) =>
  `variant-${options?.variant ?? "default"} ${options?.className ?? ""}`.trim()
)

jest.mock("@/components/ui/button", () => ({
  buttonVariants: (options?: { variant?: string; className?: string }) =>
    mockButtonVariants(options),
}))

jest.mock("@/components/ui/alert-dialog", () => {
  const ReactImpl = jest.requireActual<typeof import("react")>("react")
  const AlertDialogContext = ReactImpl.createContext<{ onOpenChange?: (open: boolean) => void }>({})

  return {
    AlertDialog: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode
      open: boolean
      onOpenChange?: (open: boolean) => void
    }) =>
      open ? (
        <AlertDialogContext.Provider value={{ onOpenChange }}>
          <div data-testid="alert-dialog">{children}</div>
        </AlertDialogContext.Provider>
      ) : null,
    AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="alert-dialog-content">{children}</div>
    ),
    AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogCancel: ({
      children,
      className,
    }: {
      children: React.ReactNode
      className?: string
    }) => {
      const ctx = ReactImpl.useContext(AlertDialogContext)
      return (
        <button type="button" className={className} onClick={() => ctx.onOpenChange?.(false)}>
          {children}
        </button>
      )
    },
    AlertDialogAction: ({
      children,
      className,
      onClick,
    }: {
      children: React.ReactNode
      className?: string
      onClick?: () => void
    }) => (
      <button type="button" className={className} onClick={onClick}>
        {children}
      </button>
    ),
  }
})

const messages = {
  a2ui: {
    deleteConfirmTitle: "Delete App",
    deleteConfirmDescription: "This action cannot be undone.",
    delete: "Delete",
    cancel: "Cancel",
    customDeleteTitle: "Remove Item",
    customDeleteDescription: "Removing this item is irreversible.",
  },
}

const renderDialog = (props?: Partial<React.ComponentProps<typeof DeleteConfirmDialog>>) => {
  const defaultProps: React.ComponentProps<typeof DeleteConfirmDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    onConfirm: jest.fn(),
    ...props,
  }

  const result = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DeleteConfirmDialog {...defaultProps} />
    </NextIntlClientProvider>
  )

  return { ...result, props: defaultProps }
}

describe("DeleteConfirmDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("does not render when closed", () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument()
  })

  it("renders default translated content when open", () => {
    renderDialog()

    expect(screen.getByText("Delete App")).toBeInTheDocument()
    // Global jest.setup.ts mocks next-intl from `i18n/messages/en.json` instead
    // of honoring the `NextIntlClientProvider` wrapper used in this file, so we
    // assert against the canonical English copy rather than the test fixture.
    expect(screen.getByText(/this action cannot be undone\./i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()
  })

  it("calls onConfirm when delete is clicked", () => {
    const onConfirm = jest.fn()
    renderDialog({ onConfirm })

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("calls onOpenChange(false) when cancel is clicked", () => {
    const onOpenChange = jest.fn()
    renderDialog({ onOpenChange })

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("supports custom title and description keys", () => {
    renderDialog({
      titleKey: "customDeleteTitle",
      descriptionKey: "customDeleteDescription",
    })

    // Custom keys are not in `en.json`, so the global next-intl mock falls
    // back to the literal key name — pin that behaviour as the contract.
    expect(screen.getByText("customDeleteTitle")).toBeInTheDocument()
    expect(screen.getByText("customDeleteDescription")).toBeInTheDocument()
  })

  it("uses destructive button variant class for confirm action", () => {
    renderDialog()

    const deleteButton = screen.getByRole("button", { name: "Delete" })
    expect(mockButtonVariants).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
      })
    )
    expect(deleteButton.className).toContain("variant-destructive")
  })
})
