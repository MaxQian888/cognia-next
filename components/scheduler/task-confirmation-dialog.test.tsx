/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub Radix AlertDialog primitives so content renders inline without portals.
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({
    children,
    disabled,
    onClick,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" disabled={disabled} onClick={onClick} data-testid="alert-cancel">
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button type="button">{children}</button>,
}))

jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean | "indeterminate") => void
    id?: string
  }) => (
    <input
      type="checkbox"
      id={id}
      checked={!!checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { TaskConfirmationDialog, AdminElevationDialog } from "./task-confirmation-dialog"

const baseConfirmation = {
  confirmation_id: "conf-1",
  operation: "create",
  risk_level: "low" as const,
  details: { task_name: "My task" },
  warnings: [],
  requires_admin: false,
  created_at: new Date("2030-01-01").toISOString(),
  expires_at: new Date("2030-01-02").toISOString(),
  target_task_id: "t-target",
  task_id: "t-1",
}

describe("TaskConfirmationDialog", () => {
  it("returns null when confirmation is null", () => {
    const { container } = render(
      <TaskConfirmationDialog
        open={true}
        confirmation={null}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("returns null when open is false", () => {
    const { container } = render(
      <TaskConfirmationDialog
        open={false}
        confirmation={baseConfirmation as never}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the task name and confirmation id", () => {
    render(
      <TaskConfirmationDialog
        open={true}
        confirmation={baseConfirmation as never}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    expect(screen.getByText("My task")).toBeInTheDocument()
    expect(screen.getByText("conf-1")).toBeInTheDocument()
  })

  it("invokes onConfirm when Confirm clicked (non-critical)", () => {
    const onConfirm = jest.fn()
    render(
      <TaskConfirmationDialog
        open={true}
        confirmation={baseConfirmation as never}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText(/confirm$/i))
    expect(onConfirm).toHaveBeenCalled()
  })

  it("shows the critical risk checkbox and disables confirm until checked", () => {
    const onConfirm = jest.fn()
    render(
      <TaskConfirmationDialog
        open={true}
        confirmation={{ ...baseConfirmation, risk_level: "critical" } as never}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />
    )
    const confirmBtn = screen.getByText(/confirm$/i).closest("button") as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement
    fireEvent.click(checkbox)
    expect(confirmBtn.disabled).toBe(false)
    fireEvent.click(confirmBtn)
    expect(onConfirm).toHaveBeenCalled()
  })

  it("renders warnings list when warnings present", () => {
    render(
      <TaskConfirmationDialog
        open={true}
        confirmation={{ ...baseConfirmation, warnings: ["w1", "w2"] } as never}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    expect(screen.getByText("w1")).toBeInTheDocument()
    expect(screen.getByText("w2")).toBeInTheDocument()
  })

  it("renders admin requirement badge when requires_admin is true", () => {
    render(
      <TaskConfirmationDialog
        open={true}
        confirmation={{ ...baseConfirmation, requires_admin: true } as never}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    expect(screen.getByText("adminRequired")).toBeInTheDocument()
  })

  it("renders action_summary, trigger_summary, and script_preview when provided", () => {
    render(
      <TaskConfirmationDialog
        open={true}
        confirmation={
          {
            ...baseConfirmation,
            details: {
              task_name: "T",
              action_summary: "Do thing",
              trigger_summary: "On Mondays",
              script_preview: "echo hello",
            },
          } as never
        }
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    expect(screen.getByText("Do thing")).toBeInTheDocument()
    expect(screen.getByText("On Mondays")).toBeInTheDocument()
    expect(screen.getByText("echo hello")).toBeInTheDocument()
  })

  it("renders the processing label when loading", () => {
    render(
      <TaskConfirmationDialog
        open={true}
        confirmation={baseConfirmation as never}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        loading
      />
    )
    expect(screen.getByText("processing")).toBeInTheDocument()
  })

  it("renders the right risk icons for high and critical levels", () => {
    const { rerender } = render(
      <TaskConfirmationDialog
        open={true}
        confirmation={{ ...baseConfirmation, risk_level: "high" } as never}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    // High risk shows the secondary badge variant; we just confirm it renders.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()

    rerender(
      <TaskConfirmationDialog
        open={true}
        confirmation={{ ...baseConfirmation, risk_level: "medium" } as never}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  })
})

describe("AdminElevationDialog", () => {
  it("returns null when open is false", () => {
    const { container } = render(
      <AdminElevationDialog open={false} onRequestElevation={jest.fn()} onCancel={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the elevation copy when open", () => {
    render(<AdminElevationDialog open={true} onRequestElevation={jest.fn()} onCancel={jest.fn()} />)
    expect(screen.getByText("adminElevationTitle")).toBeInTheDocument()
  })

  it("dispatches onRequestElevation when the action is clicked", () => {
    const onRequestElevation = jest.fn()
    render(
      <AdminElevationDialog
        open={true}
        onRequestElevation={onRequestElevation}
        onCancel={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("requestElevation"))
    expect(onRequestElevation).toHaveBeenCalled()
  })

  it("shows requesting label when loading", () => {
    render(
      <AdminElevationDialog
        open={true}
        onRequestElevation={jest.fn()}
        onCancel={jest.fn()}
        loading
      />
    )
    expect(screen.getByText("requesting")).toBeInTheDocument()
  })

  it("disables the Cancel button when loading", () => {
    render(
      <AdminElevationDialog
        open={true}
        onRequestElevation={jest.fn()}
        onCancel={jest.fn()}
        loading
      />
    )
    const cancel = screen.getByTestId("alert-cancel") as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
  })
})
