/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// SidebarTrigger needs a SidebarProvider, which in turn drives `useMobile`
// (window.matchMedia). The trigger itself isn't under test here — stub it.
jest.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: (props: React.ComponentProps<"button">) => (
    <button type="button" data-testid="sidebar-trigger-stub" {...props} />
  ),
}))

// Radix DropdownMenu portals its content and uses pointer events that jsdom
// doesn't drive consistently. Stub it to render children inline so the menu
// items are queryable directly.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({
    children,
    asChild,
    ...rest
  }: {
    children: React.ReactNode
    asChild?: boolean
  } & React.HTMLAttributes<HTMLElement>) =>
    asChild ? <>{children}</> : <button {...rest}>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement> & { onClick?: () => void }) => (
    <div
      role="menuitem"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick?.()
      }}
      tabIndex={0}
      {...rest}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

import { SchedulerContentHeader } from "./scheduler-content-header"

function setup(overrides: Partial<React.ComponentProps<typeof SchedulerContentHeader>> = {}) {
  const props: React.ComponentProps<typeof SchedulerContentHeader> = {
    onCreate: jest.fn(),
    onRefresh: jest.fn(),
    ...overrides,
  }
  return { props, ...render(<SchedulerContentHeader {...props} />) }
}

describe("SchedulerContentHeader", () => {
  it("shows the overview breadcrumb leaf when no task is selected", () => {
    setup()
    const leaf = screen.getByTestId("scheduler-breadcrumb-leaf")
    expect(leaf.textContent).toBe("overview")
  })

  it("shows the selected task name in the breadcrumb when provided", () => {
    setup({ selectedTaskName: "Backup task" })
    const leaf = screen.getByTestId("scheduler-breadcrumb-leaf")
    expect(leaf.textContent).toBe("Backup task")
    expect(leaf.className).toContain("text-foreground")
  })

  it("disables the refresh button and spins the icon while refreshing", () => {
    const onRefresh = jest.fn()
    setup({ isRefreshing: true, onRefresh })
    const refreshBtn = screen.getByRole("button", { name: /refresh/i }) as HTMLButtonElement
    expect(refreshBtn.disabled).toBe(true)
    const icon = refreshBtn.querySelector("svg")
    expect(icon?.getAttribute("class")).toMatch(/animate-spin/)
  })

  it("invokes onRefresh when the refresh button is clicked", () => {
    const onRefresh = jest.fn()
    setup({ onRefresh })
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }))
    expect(onRefresh).toHaveBeenCalled()
  })

  it("invokes onCreate when the primary New Task button is clicked", () => {
    const onCreate = jest.fn()
    setup({ onCreate })
    fireEvent.click(screen.getByTestId("scheduler-new-task-button"))
    expect(onCreate).toHaveBeenCalled()
  })

  it("opens the kind-menu dropdown and shows conditional items", () => {
    const onCreate = jest.fn()
    const onCreateSystemTask = jest.fn()
    const onCreateWorkflowTrigger = jest.fn()
    const onOpenBackupSettings = jest.fn()
    const onOpenPluginSettings = jest.fn()
    setup({
      onCreate,
      onCreateSystemTask,
      onCreateWorkflowTrigger,
      onOpenBackupSettings,
      onOpenPluginSettings,
    })

    fireEvent.click(screen.getByTestId("scheduler-new-task-kind-menu"))

    fireEvent.click(screen.getByTestId("scheduler-new-app-task"))
    expect(onCreate).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("scheduler-new-task-kind-menu"))
    fireEvent.click(screen.getByTestId("scheduler-new-workflow-trigger"))
    expect(onCreateWorkflowTrigger).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("scheduler-new-task-kind-menu"))
    fireEvent.click(screen.getByTestId("scheduler-open-backup-settings"))
    expect(onOpenBackupSettings).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("scheduler-new-task-kind-menu"))
    fireEvent.click(screen.getByTestId("scheduler-open-plugin-settings"))
    expect(onOpenPluginSettings).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("scheduler-new-task-kind-menu"))
    fireEvent.click(screen.getByTestId("scheduler-new-system-task"))
    expect(onCreateSystemTask).toHaveBeenCalled()
  })

  it("omits conditional kind-menu items when their callbacks are absent", () => {
    setup()
    fireEvent.click(screen.getByTestId("scheduler-new-task-kind-menu"))
    expect(screen.queryByTestId("scheduler-new-workflow-trigger")).toBeNull()
    expect(screen.queryByTestId("scheduler-open-backup-settings")).toBeNull()
    expect(screen.queryByTestId("scheduler-open-plugin-settings")).toBeNull()
    expect(screen.queryByTestId("scheduler-new-system-task")).toBeNull()
    // App task always renders.
    expect(screen.getByTestId("scheduler-new-app-task")).toBeInTheDocument()
  })

  it("wires the overflow menu items to their callbacks", () => {
    const onOpenTemplates = jest.fn()
    const onExport = jest.fn()
    const onImport = jest.fn()
    const onCleanup = jest.fn()
    setup({ onOpenTemplates, onExport, onImport, onCleanup })

    fireEvent.click(screen.getByRole("button", { name: /more options/i }))
    fireEvent.click(screen.getByText(/templateGallery\.title/))
    expect(onOpenTemplates).toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /more options/i }))
    fireEvent.click(screen.getByText("exportTasks"))
    expect(onExport).toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /more options/i }))
    fireEvent.click(screen.getByText("importTasks"))
    expect(onImport).toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /more options/i }))
    fireEvent.click(screen.getByText(/quickActions\.cleanup/))
    expect(onCleanup).toHaveBeenCalled()
  })

  it("renders without a refresh spin when isRefreshing defaults to false", () => {
    setup({ isRefreshing: undefined })
    const refreshBtn = screen.getByRole("button", { name: /refresh/i }) as HTMLButtonElement
    expect(refreshBtn.disabled).toBe(false)
    expect(refreshBtn.querySelector("svg")?.getAttribute("class")).not.toMatch(/animate-spin/)
  })
})
