import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button data-testid="sidebar-trigger" />,
}))

jest.mock("./scheduler-host-popover", () => ({
  SchedulerHostPopover: () => <div data-testid="host-popover" />,
  SchedulerHostStatusBadge: () => <span data-testid="host-status" />,
  SchedulerHostSummaryLine: ({ summary }: { summary: { label: string } }) => (
    <span data-testid="host-summary">{summary.label}</span>
  ),
  useSchedulerHostSummary: () => ({
    target: "local",
    label: "this device",
    pairedAvailable: false,
    suspended: false,
    onlyWhileOpen: false,
    pairedLabel: "",
    setTarget: jest.fn(),
  }),
}))

import { SchedulerPageHeader, type SchedulerPageHeaderProps } from "./scheduler-page-header"

function props(over: Partial<SchedulerPageHeaderProps> = {}): SchedulerPageHeaderProps {
  return {
    schedulerStatus: "running",
    onCreate: jest.fn(),
    onCreateSystemTask: jest.fn(),
    onCreateWorkflowTrigger: jest.fn(),
    onOpenBackupSettings: jest.fn(),
    onOpenPluginSettings: jest.fn(),
    onRefresh: jest.fn(),
    onExport: jest.fn(),
    onImport: jest.fn(),
    onOpenTemplates: jest.fn(),
    onCleanup: jest.fn(),
    ...over,
  }
}

describe("SchedulerPageHeader", () => {
  it("names the host, the scheduler state, and carries the popover and list trigger", () => {
    render(<SchedulerPageHeader {...props()} />)
    expect(screen.getByTestId("host-summary")).toHaveTextContent("this device")
    expect(screen.getByTestId("scheduler-status-badge")).toHaveTextContent("Running")
    expect(screen.getByTestId("host-popover")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-trigger")).toBeInTheDocument()
  })

  it("can omit the list trigger and says when the scheduler is stopped", () => {
    render(
      <SchedulerPageHeader {...props({ schedulerStatus: "stopped", showListTrigger: false })} />
    )
    expect(screen.queryByTestId("sidebar-trigger")).not.toBeInTheDocument()
    expect(screen.getByTestId("scheduler-status-badge")).toHaveTextContent("Scheduler stopped")
  })

  it("creates, refreshes, and offers every kind in the split menu", async () => {
    const user = userEvent.setup()
    const p = props()
    render(<SchedulerPageHeader {...p} />)
    fireEvent.click(screen.getByTestId("scheduler-new-task-button"))
    expect(p.onCreate).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("scheduler-refresh-button"))
    expect(p.onRefresh).toHaveBeenCalled()
    await user.click(screen.getByTestId("scheduler-new-task-kind-menu"))
    await user.click(await screen.findByTestId("scheduler-new-system-task"))
    expect(p.onCreateSystemTask).toHaveBeenCalled()
    await user.click(screen.getByTestId("scheduler-new-task-kind-menu"))
    await user.click(await screen.findByTestId("scheduler-new-workflow-trigger"))
    expect(p.onCreateWorkflowTrigger).toHaveBeenCalled()
  })

  it("hides a kind whose creation path is absent", async () => {
    const user = userEvent.setup()
    render(
      <SchedulerPageHeader
        {...props({ onCreateSystemTask: undefined, onOpenBackupSettings: undefined })}
      />
    )
    await user.click(screen.getByTestId("scheduler-new-task-kind-menu"))
    expect(await screen.findByTestId("scheduler-new-workflow-trigger")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-new-system-task")).not.toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-open-backup-settings")).not.toBeInTheDocument()
  })

  it("keeps templates, export, import and cleanup behind the overflow", async () => {
    const user = userEvent.setup()
    const p = props()
    render(<SchedulerPageHeader {...p} />)
    await user.click(screen.getByRole("button", { name: "More options" }))
    await user.click(await screen.findByRole("menuitem", { name: /Export Tasks/ }))
    expect(p.onExport).toHaveBeenCalled()
  })
})
