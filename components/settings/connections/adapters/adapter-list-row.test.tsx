/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
}))

// The row delegates removal (keyring purge → attachment prune → row delete)
// to the shared `removeAdapterInstance` seam; its internals are covered by
// lib/connectors/remove-adapter-instance.test.ts.
const mockRemoveAdapterInstance = jest.fn().mockResolvedValue({
  purgedCredentials: [],
  failedCredentials: [],
  prunedAttachments: 0,
})
jest.mock("@/lib/connectors/remove-adapter-instance", () => ({
  removeAdapterInstance: (...args: unknown[]) => mockRemoveAdapterInstance(...args),
}))

const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }))

const mockHealth = { current: { state: "running" }, breaker: null, rateBucket: null }
jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: () => mockHealth,
}))

const mockSetSelected = jest.fn()
const mockSetActiveTab = jest.fn()
let selectedAdapterId: string | null = null
jest.mock("./use-selected-adapter", () => ({
  useSelectedAdapter: () => ({
    selectedAdapterId,
    setSelectedAdapterId: mockSetSelected,
    activeTab: "config",
    setActiveTab: mockSetActiveTab,
  }),
}))

// Radix portals don't render into jsdom — flatten the menu + dialog.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    className?: string
  }) => (
    <button onClick={onClick} className={className}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogContent: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (e: React.MouseEvent) => void
  }) => (
    <div data-testid="alert-dialog-content" onClick={onClick}>
      {children}
    </div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode
    onClick?: (e: { preventDefault: () => void }) => void
    disabled?: boolean
  }) => (
    <button onClick={() => onClick?.({ preventDefault: () => {} })} disabled={disabled}>
      {children}
    </button>
  ),
}))

import { AdapterListRow } from "./adapter-list-row"

const baseRow: AdapterInstanceRow = {
  id: "tg-1",
  type: "telegram",
  displayName: "My Telegram Bot",
  enabled: true,
  transportMode: "longpoll",
  settings: {},
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken", "extra"] },
  trigger: defaultPrivateChatPolicy(),
  defaultMode: "auto",
  createdAt: 1000,
  updatedAt: 1000,
}

function renderRow(overrides: Partial<AdapterInstanceRow> = {}, pendingCount = 0) {
  const onConfigure = jest.fn()
  const row = { ...baseRow, ...overrides }
  render(<AdapterListRow row={row} pendingCount={pendingCount} onConfigure={onConfigure} />)
  return { row, onConfigure }
}

beforeEach(() => {
  jest.clearAllMocks()
  selectedAdapterId = null
  mockHealth.current = { state: "running" }
  mockHealth.breaker = null
  mockHealth.rateBucket = null
})

describe("AdapterListRow", () => {
  it("renders the display name, platform label and transport sublabel", () => {
    renderRow()
    expect(screen.getByText("My Telegram Bot")).toBeInTheDocument()
    expect(screen.getByText(/Telegram · longpoll/)).toBeInTheDocument()
  })

  it("renders DingTalk Stream Mode instead of the internal longpoll bucket", () => {
    renderRow({
      id: "dt-1",
      type: "dingtalk",
      displayName: "DingTalk Bot",
      transportMode: "longpoll",
    })
    expect(screen.getByText(/DingTalk .* · Stream Mode WSS/)).toBeInTheDocument()
  })

  it("selects the adapter when the row is clicked", () => {
    renderRow()
    fireEvent.click(screen.getByTestId("adapter-card-tg-1"))
    expect(mockSetSelected).toHaveBeenCalledWith("tg-1")
  })

  it("opens the configure dialog from the menu", () => {
    const { onConfigure } = renderRow()
    fireEvent.click(screen.getByText("Configure"))
    expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ id: "tg-1" }))
  })

  it("toggles enabled from the menu (enabled → disable)", () => {
    renderRow()
    fireEvent.click(screen.getByText("Disable"))
    expect(mockUpdateAdapterInstance).toHaveBeenCalledWith("tg-1", { enabled: false })
  })

  it("shows Enable for a disabled adapter and toggles it on", () => {
    renderRow({ enabled: false })
    fireEvent.click(screen.getByText("Enable"))
    expect(mockUpdateAdapterInstance).toHaveBeenCalledWith("tg-1", { enabled: true })
  })

  it("send test selects the adapter and jumps to the config tab", () => {
    renderRow()
    fireEvent.click(screen.getByText("Send test message"))
    expect(mockSetSelected).toHaveBeenCalledWith("tg-1")
    expect(mockSetActiveTab).toHaveBeenCalledWith("config")
  })

  it("removes the adapter through the shared removal seam with the full row", async () => {
    selectedAdapterId = "tg-1"
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    // Confirm button inside the alert dialog
    const confirm = screen.getAllByText("Remove").at(-1)!
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(mockRemoveAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "tg-1",
          credentialsRef: expect.objectContaining({ accounts: ["botToken", "extra"] }),
        })
      )
    )
    // Was the selected row → selection cleared
    expect(mockSetSelected).toHaveBeenCalledWith(null)
  })

  it("does not clear selection on remove when a different row was selected", async () => {
    selectedAdapterId = "other"
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    fireEvent.click(screen.getAllByText("Remove").at(-1)!)
    await waitFor(() => expect(mockRemoveAdapterInstance).toHaveBeenCalled())
    expect(mockSetSelected).not.toHaveBeenCalledWith(null)
  })

  it("shows a connected status badge when enabled and nominal", () => {
    renderRow()
    const badge = screen.getByTestId("adapter-row-status-tg-1")
    expect(badge).toHaveAttribute("data-status", "connected")
  })

  it("shows a disabled status badge when the adapter is not enabled", () => {
    renderRow({ enabled: false })
    const badge = screen.getByTestId("adapter-row-status-tg-1")
    expect(badge).toHaveAttribute("data-status", "disabled")
  })

  it("shows a warning status badge with the degraded label when degraded", () => {
    mockHealth.current = { state: "degraded" }
    renderRow()
    const badge = screen.getByTestId("adapter-row-status-tg-1")
    expect(badge).toHaveAttribute("data-status", "warning")
    expect(badge.textContent).toMatch(/Degraded/)
  })

  it("tooltips the localized reason on the status badge when down for a known cause", () => {
    mockHealth.current = {
      state: "down",
      reason: "credentials_missing",
    } as typeof mockHealth.current
    renderRow()
    const badge = screen.getByTestId("adapter-row-status-tg-1")
    expect(badge.getAttribute("title")).toMatch(/Credentials missing/i)
    mockHealth.current = { state: "running" }
  })

  it("renders the pending chip only when there are queued jobs", () => {
    const { row } = renderRow({}, 3)
    const badge = screen.getByTestId(`adapter-pending-${row.id}`)
    expect(badge.textContent).toMatch(/3/)
  })

  it("tints the pending chip for the selected row", () => {
    selectedAdapterId = "tg-1"
    renderRow({}, 2)
    expect(screen.getByTestId("adapter-pending-tg-1").className).toContain(
      "text-primary-foreground"
    )
  })

  it("stops clicks inside the remove dialog from bubbling to the row", () => {
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    mockSetSelected.mockClear()
    fireEvent.click(screen.getByTestId("alert-dialog-content"))
    // A bubbling click would have re-selected the row via the outer button.
    expect(mockSetSelected).not.toHaveBeenCalled()
  })

  it("hides the pending chip when count is zero", () => {
    renderRow({}, 0)
    expect(screen.queryByTestId("adapter-pending-tg-1")).not.toBeInTheDocument()
  })

  it("highlights the row when selected", () => {
    selectedAdapterId = "tg-1"
    renderRow()
    expect(screen.getByTestId("adapter-card-tg-1")).toHaveAttribute("aria-pressed", "true")
  })

  it("fires onAfterSelect after selecting when provided", () => {
    const onAfterSelect = jest.fn()
    render(
      <AdapterListRow
        row={baseRow}
        pendingCount={0}
        onConfigure={jest.fn()}
        onAfterSelect={onAfterSelect}
      />
    )
    fireEvent.click(screen.getByTestId("adapter-card-tg-1"))
    expect(mockSetSelected).toHaveBeenCalledWith("tg-1")
    expect(onAfterSelect).toHaveBeenCalled()
  })

  it("stringifies a non-Error removal rejection into the toast", async () => {
    mockRemoveAdapterInstance.mockRejectedValueOnce("nope")
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    fireEvent.click(screen.getAllByText("Remove").at(-1)!)
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("nope"))
  })

  it("re-enables the dialog when the removal seam rejects (row stays visible)", async () => {
    mockRemoveAdapterInstance.mockRejectedValueOnce(new Error("db closed"))
    selectedAdapterId = "tg-1"
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    fireEvent.click(screen.getAllByText("Remove").at(-1)!)
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("db closed"))
    // Selection must not be cleared when the delete did not happen.
    expect(mockSetSelected).not.toHaveBeenCalledWith(null)
  })
})
