/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: jest.fn().mockResolvedValue({ id: "new-id" }),
  updateAdapterInstance: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(false) }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringSet: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

// Radix UI Portal doesn't render content into the document in jsdom — mock
// DropdownMenu so its Content always appears in the DOM directly.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
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
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { AdaptersTab } from "./adapters-tab"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

const baseAdapter: AdapterInstanceRow = {
  id: "cai_test_1",
  type: "telegram",
  displayName: "Test Bot",
  enabled: true,
  transportMode: "longpoll",
  settings: {},
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
  trigger: defaultPrivateChatPolicy(),
  defaultMode: "auto",
  createdAt: 1000,
  updatedAt: 1000,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUseLiveQuery.mockReturnValue([baseAdapter] as unknown as ReturnType<typeof useLiveQuery>)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdaptersTab", () => {
  it("renders the adapter list when adapters exist", () => {
    render(<AdaptersTab />)
    expect(screen.getByText("Test Bot")).toBeInTheDocument()
    expect(screen.getByText("telegram")).toBeInTheDocument()
  })

  it("shows empty state when no adapters", () => {
    mockUseLiveQuery.mockReturnValue([] as unknown as ReturnType<typeof useLiveQuery>)
    render(<AdaptersTab />)
    expect(screen.getByText(/no adapters configured/i)).toBeInTheDocument()
  })

  it("renders enable/disable switch for each adapter", () => {
    render(<AdaptersTab />)
    const toggle = screen.getByRole("switch", { name: /disable test bot/i })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toBeChecked()
  })

  it("renders the Configure button for each adapter", () => {
    render(<AdaptersTab />)
    expect(screen.getByRole("button", { name: /configure test bot/i })).toBeInTheDocument()
  })

  it("shows Add adapter dropdown trigger", () => {
    render(<AdaptersTab />)
    expect(screen.getByRole("button", { name: /add adapter/i })).toBeInTheDocument()
  })

  it("opens the dropdown and shows Telegram entry as active", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => {
      expect(screen.getByText("Telegram")).toBeInTheDocument()
    })
  })

  it("shows Coming soon for non-available adapters", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => {
      expect(screen.getAllByText(/coming soon/i).length).toBeGreaterThan(0)
    })
  })

  it("opens Telegram dialog when Add → Telegram is clicked", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => screen.getByText("Telegram"))
    fireEvent.click(screen.getByText("Telegram"))
    await waitFor(() => {
      expect(screen.getByText(/add telegram bot/i)).toBeInTheDocument()
    })
  })

  it("opens Telegram configure dialog when Configure is clicked on telegram row", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /configure test bot/i }))
    await waitFor(() => {
      expect(screen.getByText(/configure telegram bot/i)).toBeInTheDocument()
    })
  })
})
