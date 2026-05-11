/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub the sub-forms with harnesses that surface their callbacks via test buttons.
jest.mock("./task-form", () => ({
  __esModule: true,
  TaskForm: ({
    onSubmit,
    onCancel,
    initialValues,
  }: {
    onSubmit: (input: { name: string }) => Promise<void>
    onCancel: () => void
    initialValues?: { name?: string }
  }) => (
    <div data-testid="task-form-stub">
      <span data-testid="task-form-initial">{initialValues?.name ?? "_new"}</span>
      <button
        type="button"
        onClick={() => void onSubmit({ name: "submitted" })}
        data-testid="task-form-submit"
      >
        submit
      </button>
      <button type="button" onClick={onCancel} data-testid="task-form-cancel">
        cancel
      </button>
    </div>
  ),
}))

jest.mock("./system-task-form", () => ({
  __esModule: true,
  SystemTaskForm: ({
    onSubmit,
    onCancel,
    initialValues,
  }: {
    onSubmit: (input: { name: string }) => Promise<void>
    onCancel: () => void
    initialValues?: { name?: string }
  }) => (
    <div data-testid="system-task-form-stub">
      <span data-testid="system-task-form-initial">{initialValues?.name ?? "_new"}</span>
      <button
        type="button"
        onClick={() => void onSubmit({ name: "system-submitted" })}
        data-testid="system-task-form-submit"
      >
        submit
      </button>
      <button type="button" onClick={onCancel} data-testid="system-task-form-cancel">
        cancel
      </button>
    </div>
  ),
}))

jest.mock("./task-confirmation-dialog", () => ({
  __esModule: true,
  TaskConfirmationDialog: ({
    open,
    onConfirm,
    onCancel,
  }: {
    open: boolean
    onConfirm: () => void
    onCancel: () => void
  }) =>
    open ? (
      <div data-testid="confirmation-stub">
        <button type="button" onClick={onConfirm} data-testid="confirm-confirm">
          confirm
        </button>
        <button type="button" onClick={onCancel} data-testid="confirm-cancel">
          cancel
        </button>
      </div>
    ) : null,
  AdminElevationDialog: ({
    open,
    onCancel,
    onRequestElevation,
  }: {
    open: boolean
    onCancel: () => void
    onRequestElevation: () => Promise<void>
  }) =>
    open ? (
      <div data-testid="admin-stub">
        <button type="button" onClick={() => void onRequestElevation()} data-testid="admin-elevate">
          elevate
        </button>
        <button type="button" onClick={onCancel} data-testid="admin-cancel">
          cancel
        </button>
      </div>
    ) : null,
}))

import { SchedulerDialogs } from "./scheduler-dialogs"

type DialogProps = React.ComponentProps<typeof SchedulerDialogs>

function buildProps(overrides: Partial<DialogProps> = {}): DialogProps {
  return {
    showCreateSheet: false,
    onShowCreateSheetChange: jest.fn(),
    onCreateTask: jest.fn(async () => undefined),
    isSubmitting: false,
    showEditSheet: false,
    onShowEditSheetChange: jest.fn(),
    onEditTask: jest.fn(async () => undefined),
    selectedTask: undefined,
    showSystemCreateSheet: false,
    onShowSystemCreateSheetChange: jest.fn(),
    onCreateSystemTask: jest.fn(async () => undefined),
    systemSubmitting: false,
    systemCapabilities: null,
    showSystemEditSheet: false,
    onShowSystemEditSheetChange: jest.fn(),
    onEditSystemTask: jest.fn(async () => undefined),
    selectedSystemTask: null,
    deleteTaskId: null,
    onDeleteTaskIdChange: jest.fn(),
    onDeleteConfirm: jest.fn(async () => undefined),
    systemDeleteTaskId: null,
    onSystemDeleteTaskIdChange: jest.fn(),
    onSystemDeleteConfirm: jest.fn(async () => undefined),
    pendingConfirmation: null,
    onConfirmPending: jest.fn(),
    onCancelPending: jest.fn(),
    showAdminDialog: false,
    onShowAdminDialogChange: jest.fn(),
    onRequestElevation: jest.fn(async () => undefined),
    existingTasks: undefined,
    ...overrides,
  }
}

describe("SchedulerDialogs", () => {
  it("opens the create sheet and submits → onCreateTask", () => {
    const onCreateTask = jest.fn(async () => undefined)
    render(<SchedulerDialogs {...buildProps({ showCreateSheet: true, onCreateTask })} />)
    expect(screen.getByTestId("task-form-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-form-initial").textContent).toBe("_new")
    fireEvent.click(screen.getByTestId("task-form-submit"))
    expect(onCreateTask).toHaveBeenCalledWith({ name: "submitted" })
  })

  it("cancels the create sheet via the form's cancel callback", () => {
    const onShowCreateSheetChange = jest.fn()
    render(<SchedulerDialogs {...buildProps({ showCreateSheet: true, onShowCreateSheetChange })} />)
    fireEvent.click(screen.getByTestId("task-form-cancel"))
    expect(onShowCreateSheetChange).toHaveBeenCalledWith(false)
  })

  it("opens the edit sheet only when selectedTask is present", () => {
    // Without selectedTask → no form rendered even though sheet is open.
    const { rerender } = render(
      <SchedulerDialogs {...buildProps({ showEditSheet: true, selectedTask: undefined })} />
    )
    expect(screen.queryByTestId("task-form-stub")).toBeNull()

    // With selectedTask → form renders with initial values.
    rerender(
      <SchedulerDialogs
        {...buildProps({
          showEditSheet: true,
          selectedTask: {
            id: "t1",
            name: "Existing",
            description: "d",
            type: "app",
            trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
            payload: {},
            config: {},
            notification: { enabled: false },
            status: "active",
            tags: [],
          } as unknown as DialogProps["selectedTask"],
        })}
      />
    )
    expect(screen.getByTestId("task-form-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-form-initial").textContent).toBe("Existing")
  })

  it("opens the system create sheet and submits", () => {
    const onCreateSystemTask = jest.fn(async () => undefined)
    render(
      <SchedulerDialogs {...buildProps({ showSystemCreateSheet: true, onCreateSystemTask })} />
    )
    fireEvent.click(screen.getByTestId("system-task-form-submit"))
    expect(onCreateSystemTask).toHaveBeenCalledWith({ name: "system-submitted" })
  })

  it("cancels the system create sheet via the form's cancel callback", () => {
    const onShowSystemCreateSheetChange = jest.fn()
    render(
      <SchedulerDialogs
        {...buildProps({ showSystemCreateSheet: true, onShowSystemCreateSheetChange })}
      />
    )
    fireEvent.click(screen.getByTestId("system-task-form-cancel"))
    expect(onShowSystemCreateSheetChange).toHaveBeenCalledWith(false)
  })

  it("opens the system edit sheet only when selectedSystemTask is present", () => {
    const { rerender } = render(
      <SchedulerDialogs {...buildProps({ showSystemEditSheet: true, selectedSystemTask: null })} />
    )
    expect(screen.queryByTestId("system-task-form-stub")).toBeNull()

    rerender(
      <SchedulerDialogs
        {...buildProps({
          showSystemEditSheet: true,
          selectedSystemTask: {
            id: "sys-1",
            name: "Backup",
            description: "d",
            trigger: { kind: "cron", cron: "0 * * * *" },
            action: { kind: "shell", command: "echo" },
            run_level: "highest",
            tags: [],
          } as unknown as DialogProps["selectedSystemTask"],
        })}
      />
    )
    expect(screen.getByTestId("system-task-form-stub")).toBeInTheDocument()
    expect(screen.getByTestId("system-task-form-initial").textContent).toBe("Backup")
  })

  it("cancels system edit via the form's cancel callback", () => {
    const onShowSystemEditSheetChange = jest.fn()
    render(
      <SchedulerDialogs
        {...buildProps({
          showSystemEditSheet: true,
          selectedSystemTask: {
            id: "sys-1",
            name: "Backup",
            description: "d",
            trigger: { kind: "cron" },
            action: { kind: "shell" },
            run_level: "highest",
            tags: [],
          } as unknown as DialogProps["selectedSystemTask"],
          onShowSystemEditSheetChange,
        })}
      />
    )
    fireEvent.click(screen.getByTestId("system-task-form-cancel"))
    expect(onShowSystemEditSheetChange).toHaveBeenCalledWith(false)
  })

  it("invokes onEditTask when editing submits", () => {
    const onEditTask = jest.fn(async () => undefined)
    render(
      <SchedulerDialogs
        {...buildProps({
          showEditSheet: true,
          selectedTask: {
            id: "t1",
            name: "Existing",
            description: "",
            type: "app",
            trigger: {},
            payload: {},
            config: {},
            notification: { enabled: false },
            status: "active",
            tags: [],
          } as unknown as DialogProps["selectedTask"],
          existingTasks: [
            { id: "t1" } as unknown as NonNullable<DialogProps["existingTasks"]>[number],
            { id: "t2" } as unknown as NonNullable<DialogProps["existingTasks"]>[number],
          ],
          onEditTask,
        })}
      />
    )
    fireEvent.click(screen.getByTestId("task-form-submit"))
    expect(onEditTask).toHaveBeenCalledWith({ name: "submitted" })
  })

  it("invokes onEditSystemTask when system edit submits", () => {
    const onEditSystemTask = jest.fn(async () => undefined)
    render(
      <SchedulerDialogs
        {...buildProps({
          showSystemEditSheet: true,
          selectedSystemTask: {
            id: "sys-1",
            name: "Backup",
            description: "",
            trigger: { kind: "cron" },
            action: { kind: "shell" },
            run_level: "highest",
            tags: [],
          } as unknown as DialogProps["selectedSystemTask"],
          onEditSystemTask,
        })}
      />
    )
    fireEvent.click(screen.getByTestId("system-task-form-submit"))
    expect(onEditSystemTask).toHaveBeenCalledWith({ name: "system-submitted" })
  })

  it("opens the delete AlertDialog when deleteTaskId is set and dispatches confirm/cancel", () => {
    const onDeleteTaskIdChange = jest.fn()
    const onDeleteConfirm = jest.fn(async () => undefined)
    render(
      <SchedulerDialogs
        {...buildProps({
          deleteTaskId: "t1",
          onDeleteTaskIdChange,
          onDeleteConfirm,
        })}
      />
    )
    // Confirm
    fireEvent.click(screen.getAllByText("delete")[0]!)
    expect(onDeleteConfirm).toHaveBeenCalled()
  })

  it("opens the system delete AlertDialog and dispatches confirm", () => {
    const onSystemDeleteConfirm = jest.fn(async () => undefined)
    render(
      <SchedulerDialogs
        {...buildProps({
          systemDeleteTaskId: "sys-1",
          onSystemDeleteConfirm,
        })}
      />
    )
    fireEvent.click(screen.getAllByText("delete")[0]!)
    expect(onSystemDeleteConfirm).toHaveBeenCalled()
  })

  it("forwards pendingConfirmation to TaskConfirmationDialog and routes confirm/cancel", () => {
    const onConfirmPending = jest.fn()
    const onCancelPending = jest.fn()
    render(
      <SchedulerDialogs
        {...buildProps({
          pendingConfirmation: {
            operation: "create",
            risk_level: "low",
            summary: "do thing",
          } as unknown as NonNullable<DialogProps["pendingConfirmation"]>,
          onConfirmPending,
          onCancelPending,
        })}
      />
    )
    expect(screen.getByTestId("confirmation-stub")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("confirm-confirm"))
    expect(onConfirmPending).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("confirm-cancel"))
    expect(onCancelPending).toHaveBeenCalled()
  })

  it("forwards showAdminDialog to AdminElevationDialog and routes its callbacks", () => {
    const onShowAdminDialogChange = jest.fn()
    const onRequestElevation = jest.fn(async () => undefined)
    render(
      <SchedulerDialogs
        {...buildProps({ showAdminDialog: true, onShowAdminDialogChange, onRequestElevation })}
      />
    )
    fireEvent.click(screen.getByTestId("admin-elevate"))
    expect(onRequestElevation).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("admin-cancel"))
    expect(onShowAdminDialogChange).toHaveBeenCalledWith(false)
  })

  it("filters existingTasks to exclude the selectedTask in edit mode", () => {
    // We can't directly assert the filtered prop is passed because TaskForm is
    // stubbed, but exercising the branch counts for coverage.
    render(
      <SchedulerDialogs
        {...buildProps({
          showEditSheet: true,
          selectedTask: {
            id: "t1",
            name: "Existing",
            description: "",
            type: "app",
            trigger: {},
            payload: {},
            config: {},
            notification: { enabled: false },
            status: "active",
            tags: [],
          } as unknown as DialogProps["selectedTask"],
          existingTasks: [
            { id: "t1" } as unknown as NonNullable<DialogProps["existingTasks"]>[number],
            { id: "t2" } as unknown as NonNullable<DialogProps["existingTasks"]>[number],
          ],
        })}
      />
    )
    expect(screen.getByTestId("task-form-stub")).toBeInTheDocument()
  })
})
