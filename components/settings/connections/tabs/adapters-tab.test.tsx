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
  deleteAdapterInstance: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(false) }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringSet: jest.fn().mockResolvedValue(undefined),
  connectorsKeyringDelete: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

// Each AdapterListRow calls useAdapterHealth → useLiveQuery. Stub it to a
// nominal state so it doesn't consume the modulo-2 useLiveQuery sequence
// below and so no health badge renders.
jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: () => ({ current: { state: "running" }, breaker: null, rateBucket: null }),
}))

// Radix UI Portal doesn't render content into the document in jsdom — mock
// DropdownMenu so its Content (add menu + row action menu) always appears in
// the DOM directly.
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

// The row's destructive AlertDialog is closed in these tests — render nothing
// unless open so it doesn't bleak a second "Remove" into the DOM.
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { AdaptersTab } from "./adapters-tab"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import type { OutboundJobRow } from "@/lib/db/connector-types"

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

/**
 * `AdaptersTab` calls `useLiveQuery` twice in a fixed order:
 *   1) adapterInstances rows
 *   2) outboundQueue rows
 * (The per-row health hook is mocked, so it does not add to this sequence.)
 * This helper drives each call independently. Modulo by 2 so re-renders
 * re-issue the same sequence.
 */
function setupAdapterQueries(opts: {
  adapters: AdapterInstanceRow[]
  jobs?: OutboundJobRow[]
}): void {
  let i = 0
  mockUseLiveQuery.mockImplementation(() => {
    const value = [opts.adapters, opts.jobs ?? []][i % 2]
    i++
    return value as unknown as ReturnType<typeof useLiveQuery>
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  setupAdapterQueries({ adapters: [baseAdapter] })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdaptersTab", () => {
  it("renders the adapter list when adapters exist", () => {
    render(<AdaptersTab />)
    expect(screen.getByText("Test Bot")).toBeInTheDocument()
    // Transport shows in the row sublabel.
    expect(screen.getByText(/longpoll/)).toBeInTheDocument()
  })

  it("shows empty state when no adapters", () => {
    setupAdapterQueries({ adapters: [] })
    render(<AdaptersTab />)
    expect(screen.getByText(/no adapters configured/i)).toBeInTheDocument()
  })

  it("exposes enable/disable in the row action menu", () => {
    render(<AdaptersTab />)
    // Row is enabled → menu offers "Disable".
    expect(screen.getByText("Disable")).toBeInTheDocument()
  })

  it("exposes Configure in the row action menu", () => {
    render(<AdaptersTab />)
    expect(screen.getByText("Configure")).toBeInTheDocument()
  })

  it("shows Add adapter dropdown trigger", () => {
    render(<AdaptersTab />)
    expect(screen.getByRole("button", { name: /add adapter/i })).toBeInTheDocument()
  })

  it("opens the dropdown and shows the Telegram entry", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Telegram" })).toBeInTheDocument()
    })
  })

  it("does not show Coming soon — all five platforms are active", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => expect(screen.queryAllByText(/lark \/ feishu/i).length).toBeGreaterThan(0))
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0)
  })

  it("opens Telegram dialog when Add → Telegram is clicked", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    fireEvent.click(screen.getByRole("button", { name: "Telegram" }))
    await waitFor(() => {
      expect(screen.getByText(/add telegram bot/i)).toBeInTheDocument()
    })
  })

  it("opens Telegram configure dialog from the row menu", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByText("Configure"))
    await waitFor(() => {
      expect(screen.getByText(/configure telegram bot/i)).toBeInTheDocument()
    })
  })

  it("shows Lark as an active menu entry", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => screen.getByRole("button", { name: /lark \/ feishu/i }))
    const button = screen.getByRole("button", { name: /lark \/ feishu/i })
    expect(button).not.toBeDisabled()
  })

  it("opens Lark dialog when Add → Lark / Feishu is clicked", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    fireEvent.click(screen.getByRole("button", { name: /lark \/ feishu/i }))
    await waitFor(() => {
      expect(screen.getByText(/add lark bot/i)).toBeInTheDocument()
    })
  })

  it("opens Lark configure dialog from the row menu", async () => {
    const larkRow: AdapterInstanceRow = {
      ...baseAdapter,
      id: "cai_lark_1",
      type: "lark",
      displayName: "Lark Probe",
      transportMode: "webhook",
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["appId", "appSecret", "verificationToken"],
      },
    }
    setupAdapterQueries({ adapters: [larkRow] })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByText("Configure"))
    await waitFor(() => {
      expect(screen.getByText(/configure lark bot/i)).toBeInTheDocument()
    })
  })

  it.each<[string, RegExp, RegExp]>([
    ["Discord", /^discord$/i, /add discord bot/i],
    ["Slack", /^slack$/i, /add slack bot/i],
    ["QQ (OneBot / NapCat)", /qq \(onebot \/ napcat\)/i, /add onebot/i],
  ])("opens the %s dialog when Add → %s is clicked", async (_label, menuText, dialogText) => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => expect(screen.getByRole("button", { name: menuText })).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: menuText }))
    await waitFor(() => {
      expect(screen.getByText(dialogText)).toBeInTheDocument()
    })
  })

  it.each<[string, AdapterInstanceRow["type"], RegExp]>([
    ["discord", "discord", /configure discord bot/i],
    ["slack", "slack", /configure slack bot/i],
    ["onebot", "onebot", /configure onebot/i],
  ])("opens the %s configure dialog from the row menu", async (kind, type, dialogText) => {
    const row: AdapterInstanceRow = {
      ...baseAdapter,
      id: `cai_${kind}_1`,
      type,
      displayName: `${kind} Probe`,
      transportMode: type === "onebot" ? "reverse-ws" : "gateway",
    }
    setupAdapterQueries({ adapters: [row] })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByText("Configure"))
    await waitFor(() => {
      expect(screen.getByText(dialogText)).toBeInTheDocument()
    })
  })

  it("renders the pending-outbound badge when the adapter has queued jobs", () => {
    const job: OutboundJobRow = {
      id: "job-pend",
      adapterId: baseAdapter.id,
      conversationKey: "telegram:cai_test_1:1",
      request: {
        conversationRef: { platform: "telegram", adapterId: baseAdapter.id },
        segments: [],
        metadata: { idempotencyKey: "k" },
      },
      status: "pending",
      attempts: 0,
      createdAt: 1,
      nextAttemptAt: 1,
      idempotencyKey: "k",
      source: "ai-run",
    }
    setupAdapterQueries({
      adapters: [baseAdapter],
      jobs: [job, { ...job, id: "job-sending", status: "sending" }],
    })
    render(<AdaptersTab />)
    const badge = screen.getByTestId(`adapter-pending-${baseAdapter.id}`)
    expect(badge).toBeInTheDocument()
    expect(badge.textContent).toMatch(/2/)
  })

  it("does not render the pending badge when no jobs are queued", () => {
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    expect(screen.queryByTestId(`adapter-pending-${baseAdapter.id}`)).not.toBeInTheDocument()
  })

  it("excludes sent/failed/deadlettered jobs from the pending count", () => {
    const job = (status: OutboundJobRow["status"], id: string): OutboundJobRow => ({
      id,
      adapterId: baseAdapter.id,
      conversationKey: "telegram:cai_test_1:1",
      request: {
        conversationRef: { platform: "telegram", adapterId: baseAdapter.id },
        segments: [],
        metadata: { idempotencyKey: id },
      },
      status,
      attempts: 0,
      createdAt: 1,
      nextAttemptAt: 1,
      idempotencyKey: id,
      source: "ai-run",
    })
    setupAdapterQueries({
      adapters: [baseAdapter],
      jobs: [
        job("sent", "j1"),
        job("failed", "j2"),
        job("deadlettered", "j3"),
        job("pending", "j4"),
      ],
    })
    render(<AdaptersTab />)
    const badge = screen.getByTestId(`adapter-pending-${baseAdapter.id}`)
    expect(badge.textContent).toMatch(/1/)
  })
})
