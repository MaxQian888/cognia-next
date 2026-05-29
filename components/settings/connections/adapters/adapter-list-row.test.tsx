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
const mockDeleteAdapterInstance = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
  deleteAdapterInstance: (...args: unknown[]) => mockDeleteAdapterInstance(...args),
}))

const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringDelete: (...args: unknown[]) => mockKeyringDelete(...args),
}))

const mockIsTauri = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

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
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  mockIsTauri.mockReturnValue(true)
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

  it("removes the adapter: clears keyring secrets then deletes the row", async () => {
    selectedAdapterId = "tg-1"
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    // Confirm button inside the alert dialog
    const confirm = screen.getAllByText("Remove").at(-1)!
    fireEvent.click(confirm)
    await waitFor(() => expect(mockDeleteAdapterInstance).toHaveBeenCalledWith("tg-1"))
    expect(mockKeyringDelete).toHaveBeenCalledWith("tg-1", "botToken")
    expect(mockKeyringDelete).toHaveBeenCalledWith("tg-1", "extra")
    // Was the selected row → selection cleared
    expect(mockSetSelected).toHaveBeenCalledWith(null)
  })

  it("skips keyring cleanup off-desktop but still deletes", async () => {
    mockIsTauri.mockReturnValue(false)
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    fireEvent.click(screen.getAllByText("Remove").at(-1)!)
    await waitFor(() => expect(mockDeleteAdapterInstance).toHaveBeenCalledWith("tg-1"))
    expect(mockKeyringDelete).not.toHaveBeenCalled()
  })

  it("does not clear selection on remove when a different row was selected", async () => {
    selectedAdapterId = "other"
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    fireEvent.click(screen.getAllByText("Remove").at(-1)!)
    await waitFor(() => expect(mockDeleteAdapterInstance).toHaveBeenCalled())
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

  it("renders the pending chip only when there are queued jobs", () => {
    const { row } = renderRow({}, 3)
    const badge = screen.getByTestId(`adapter-pending-${row.id}`)
    expect(badge.textContent).toMatch(/3/)
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

  it("swallows keyring delete failures and still deletes the row", async () => {
    mockKeyringDelete.mockRejectedValueOnce(new Error("already gone"))
    selectedAdapterId = "tg-1"
    renderRow()
    fireEvent.click(screen.getByText("Remove"))
    fireEvent.click(screen.getAllByText("Remove").at(-1)!)
    await waitFor(() => expect(mockDeleteAdapterInstance).toHaveBeenCalledWith("tg-1"))
  })
})
