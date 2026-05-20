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
 * This helper drives each call independently. Modulo by 2 so re-renders
 * (selection toggles, switch flips) re-issue the same sequence.
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
    expect(screen.getByText("telegram")).toBeInTheDocument()
  })

  it("shows empty state when no adapters", () => {
    setupAdapterQueries({ adapters: [] })
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

  it("does not show Coming soon — all five platforms are now active", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => expect(screen.queryAllByText(/lark \/ feishu/i).length).toBeGreaterThan(0))
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0)
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

  // im-refactored-crayon — Lark moves out of "Coming soon" and the existing
  // LarkConfigDialog is now wired into the add / configure dispatchers.

  it("shows Lark as an active menu entry (no Coming soon badge)", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => screen.getByText(/lark/i))
    const larkItem = screen.getByText(/lark \/ feishu/i)
    // Walk up to the menu-item button — it must be enabled now.
    const button = larkItem.closest("button")
    expect(button).not.toBeNull()
    expect(button).not.toBeDisabled()
  })

  it("opens Lark dialog when Add → Lark / Feishu is clicked", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    await waitFor(() => screen.getByText(/lark \/ feishu/i))
    fireEvent.click(screen.getByText(/lark \/ feishu/i))
    await waitFor(() => {
      expect(screen.getByText(/add lark bot/i)).toBeInTheDocument()
    })
  })

  it("opens Lark configure dialog when Configure is clicked on a lark row", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: /configure lark probe/i }))
    await waitFor(() => {
      expect(screen.getByText(/configure lark bot/i)).toBeInTheDocument()
    })
  })

  // im-refactored-crayon — Discord, Slack, OneBot move out of "Coming soon"
  // and into the dialog dispatcher alongside Telegram + Lark.

  it.each<[string, RegExp, RegExp]>([
    ["Discord", /^discord$/i, /add discord bot/i],
    ["Slack", /^slack$/i, /add slack bot/i],
    ["OneBot v11 \\(QQ\\)", /^onebot v11 \(qq\)$/i, /add onebot/i],
  ])("opens the %s dialog when Add → %s is clicked", async (_label, menuText, dialogText) => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    // The sidebar card may also contain text matching `menuText` (the
    // platform badge), so query by role + exact accessible name to hit
    // the dropdown menu button.
    await waitFor(() => expect(screen.getByRole("button", { name: menuText })).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: menuText }))
    await waitFor(() => {
      expect(screen.getByText(dialogText)).toBeInTheDocument()
    })
  })

  it("opens Discord configure dialog when Configure is clicked on a discord row", async () => {
    const dcRow: AdapterInstanceRow = {
      ...baseAdapter,
      id: "cai_dc_1",
      type: "discord",
      displayName: "Discord Probe",
      transportMode: "gateway",
    }
    setupAdapterQueries({ adapters: [dcRow] })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /configure discord probe/i }))
    await waitFor(() => {
      expect(screen.getByText(/configure discord bot/i)).toBeInTheDocument()
    })
  })

  it("opens Slack configure dialog when Configure is clicked on a slack row", async () => {
    const slRow: AdapterInstanceRow = {
      ...baseAdapter,
      id: "cai_sl_1",
      type: "slack",
      displayName: "Slack Probe",
      transportMode: "gateway",
    }
    setupAdapterQueries({ adapters: [slRow] })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /configure slack probe/i }))
    await waitFor(() => {
      expect(screen.getByText(/configure slack bot/i)).toBeInTheDocument()
    })
  })

  it("opens OneBot configure dialog when Configure is clicked on a onebot row", async () => {
    const obRow: AdapterInstanceRow = {
      ...baseAdapter,
      id: "cai_ob_1",
      type: "onebot",
      displayName: "OneBot Probe",
      transportMode: "reverse-ws",
    }
    setupAdapterQueries({ adapters: [obRow] })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /configure onebot probe/i }))
    await waitFor(() => {
      expect(screen.getByText(/configure onebot/i)).toBeInTheDocument()
    })
  })

  it("renders the pending-outbound badge when the adapter has queued jobs (Task P2.1)", () => {
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

  it("no menu entry is gated 'Coming soon' (all five active)", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByRole("button", { name: /add adapter/i }))
    // Wait until at least one menu item has rendered; any platform works.
    await waitFor(() => expect(screen.queryAllByText(/lark \/ feishu/i).length).toBeGreaterThan(0))
    expect(screen.queryAllByText(/coming soon/i)).toHaveLength(0)
  })
})
