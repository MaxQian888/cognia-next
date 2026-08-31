/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
jest.mock("@/hooks/use-tunnel-status", () => ({
  useTunnelStatus: () => ({ running: false, url: null, loading: false }),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const mockPluginConnectors = jest.fn(() => [] as unknown[])
jest.mock("@/lib/connectors/plugin-connector-registry", () => {
  const actual = jest.requireActual("@/lib/connectors/plugin-connector-registry")
  return { ...actual, listPluginConnectors: () => mockPluginConnectors() }
})
jest.mock("../forms/plugin-connector-config", () => ({
  PluginConnectorConfigDialog: ({ kind }: { kind: string }) => (
    <div data-testid="plugin-connector-dialog">{kind}</div>
  ),
}))

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

// Control the selected-adapter URL state (shared module with AdapterListRow).
let selectedAdapterIdValue: string | null = null
let pendingPlatformValue: string | null = null
const mockClearPendingPlatform = jest.fn()
const mockSetSelectedAdapterId = jest.fn()
jest.mock("../adapters/use-selected-adapter", () => ({
  useSelectedAdapter: () => ({
    selectedAdapterId: selectedAdapterIdValue,
    setSelectedAdapterId: mockSetSelectedAdapterId,
    activeTab: "config",
    setActiveTab: jest.fn(),
  }),
  usePendingPlatform: () => ({
    pendingPlatform: pendingPlatformValue,
    clearPendingPlatform: mockClearPendingPlatform,
  }),
}))

// Stub the detail panel so the tab test stays focused on the list/selection.
jest.mock("../adapters/adapter-detail-panel", () => ({
  AdapterDetailPanel: ({ adapterId }: { adapterId: string }) => (
    <div data-testid="mock-detail-panel" data-adapter-id={adapterId} />
  ),
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
  mediaModelPolicy: "local_extract_only",
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
  selectedAdapterIdValue = null
  pendingPlatformValue = null
  mockClearPendingPlatform.mockClear()
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

  it("shows the Add adapter button", () => {
    render(<AdaptersTab />)
    expect(screen.getByTestId("add-adapter-button")).toBeInTheDocument()
  })

  it("opens the picker grid from the mobile top-bar Add button", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("mobile-add-adapter-button"))
    await waitFor(() => {
      expect(screen.getByTestId("add-connector-card-telegram")).toBeInTheDocument()
    })
  })

  it("opens the picker grid and shows the Telegram + Matrix cards", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    await waitFor(() => {
      expect(screen.getByTestId("add-connector-card-telegram")).toBeInTheDocument()
    })
    // Matrix is now a first-class configurable platform in the picker.
    expect(screen.getByTestId("add-connector-card-matrix")).toBeInTheDocument()
  })

  it("shows the planned platforms as disabled cards in the picker", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    await waitFor(() => screen.getByTestId("add-connector-card-telegram"))
    for (const kind of ["email", "kook", "line", "mattermost"]) {
      const card = screen.getByTestId(`add-connector-card-${kind}`)
      expect(card).toBeDisabled()
      expect(screen.getByTestId(`add-connector-planned-${kind}`)).toBeInTheDocument()
    }
    // Clicking a planned card opens no dialog.
    fireEvent.click(screen.getByTestId("add-connector-card-kook"))
    expect(screen.queryByText(/add kook/i)).not.toBeInTheDocument()
  })

  it("filters the picker grid by search query", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    await waitFor(() => screen.getByTestId("add-connector-search"))
    fireEvent.change(screen.getByTestId("add-connector-search"), { target: { value: "matrix" } })
    await waitFor(() => {
      expect(screen.getByTestId("add-connector-card-matrix")).toBeInTheDocument()
      expect(screen.queryByTestId("add-connector-card-telegram")).not.toBeInTheDocument()
    })
  })

  it("opens Telegram dialog when its picker card is clicked", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    await waitFor(() => screen.getByTestId("add-connector-card-telegram"))
    fireEvent.click(screen.getByTestId("add-connector-card-telegram"))
    await waitFor(() => {
      expect(screen.getByText(/add telegram bot/i)).toBeInTheDocument()
    })
  })

  it("opens the Matrix dialog when its picker card is clicked", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    await waitFor(() => screen.getByTestId("add-connector-card-matrix"))
    fireEvent.click(screen.getByTestId("add-connector-card-matrix"))
    await waitFor(() => {
      expect(screen.getByText(/add matrix connector/i)).toBeInTheDocument()
    })
  })

  it("opens the DingTalk dialog when its picker card is clicked", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    await waitFor(() => screen.getByTestId("add-connector-card-dingtalk"))
    fireEvent.click(screen.getByTestId("add-connector-card-dingtalk"))
    await waitFor(() => {
      expect(screen.getByText(/add dingtalk connector/i)).toBeInTheDocument()
    })
  })

  it("opens Telegram configure dialog from the row menu", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByText("Configure"))
    await waitFor(() => {
      expect(screen.getByText(/configure telegram bot/i)).toBeInTheDocument()
    })
  })

  it("opens Lark dialog when its picker card is clicked", async () => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    await waitFor(() => screen.getByTestId("add-connector-card-lark"))
    fireEvent.click(screen.getByTestId("add-connector-card-lark"))
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

  it.each<[string, RegExp]>([
    ["discord", /add discord bot/i],
    ["slack", /add slack bot/i],
    ["onebot", /add onebot/i],
    ["wecom", /add wecom/i],
    ["wechat-personal", /add personal wechat/i],
    ["qq-official", /add qq official bot/i],
    ["wechat-oa", /add wechat official account/i],
  ])("opens the %s dialog when its picker card is clicked", async (kind, dialogText) => {
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    await waitFor(() => screen.getByTestId(`add-connector-card-${kind}`))
    fireEvent.click(screen.getByTestId(`add-connector-card-${kind}`))
    await waitFor(() => {
      expect(screen.getByText(dialogText)).toBeInTheDocument()
    })
  })

  it.each<[string, AdapterInstanceRow["type"], RegExp]>([
    ["discord", "discord", /configure discord bot/i],
    ["slack", "slack", /configure slack bot/i],
    ["onebot", "onebot", /configure onebot/i],
    ["wecom", "wecom", /configure wecom/i],
    ["wechat-personal", "wechat-personal", /configure personal wechat/i],
    ["qq-official", "qq-official", /edit qq official bot/i],
    ["wechat-oa", "wechat-oa", /edit wechat official account/i],
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

  const disabledAdapter: AdapterInstanceRow = {
    ...baseAdapter,
    id: "cai_test_2",
    type: "discord",
    displayName: "Discord Bot",
    enabled: false,
  }

  it("filters the sidebar list by the search query", () => {
    setupAdapterQueries({ adapters: [baseAdapter, disabledAdapter] })
    render(<AdaptersTab />)
    expect(screen.getByText("Test Bot")).toBeInTheDocument()
    expect(screen.getByText("Discord Bot")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("adapter-sidebar-search"), { target: { value: "discord" } })
    expect(screen.queryByText("Test Bot")).not.toBeInTheDocument()
    expect(screen.getByText("Discord Bot")).toBeInTheDocument()
  })

  it("filters the sidebar list by the Disabled status tab", async () => {
    setupAdapterQueries({ adapters: [baseAdapter, disabledAdapter] })
    render(<AdaptersTab />)
    await userEvent.click(screen.getByRole("tab", { name: /^disabled$/i }))
    expect(screen.queryByText("Test Bot")).not.toBeInTheDocument()
    expect(screen.getByText("Discord Bot")).toBeInTheDocument()
  })

  it("renders the detail panel and mobile bar name when an adapter is selected", () => {
    selectedAdapterIdValue = "cai_test_1"
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    expect(screen.getByTestId("mock-detail-panel")).toHaveAttribute("data-adapter-id", "cai_test_1")
    // Selected adapter name appears in the list row + the mobile top bar.
    expect(screen.getAllByText("Test Bot").length).toBeGreaterThan(0)
  })

  it("clicking a row selects the adapter (firing the drawer-close callback)", () => {
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    // Row click runs the onAfterSelect closure wired by AdaptersTab.
    fireEvent.click(screen.getByTestId("adapter-card-cai_test_1"))
    expect(mockSetSelectedAdapterId).toHaveBeenCalledWith("cai_test_1")
  })

  it("closes the active config dialog on dismiss", async () => {
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByText("Configure"))
    await waitFor(() => expect(screen.getByText(/configure telegram bot/i)).toBeInTheDocument())
    // Escape dismisses the Radix dialog → onOpenChange(false) → closeDialog.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" })
    await waitFor(() =>
      expect(screen.queryByText(/configure telegram bot/i)).not.toBeInTheDocument()
    )
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

  /**
   * A plugin could always own a `PlatformKind` and run the full supervisor
   * path — it just could not be configured, because this list was eleven
   * hardcoded literals and the picker never showed the kind.
   */
  it("offers a contributed kind in the picker, named by its contribution", async () => {
    mockPluginConnectors.mockReturnValue([
      {
        pluginId: "acme-chat",
        type: "acme",
        def: { type: "acme", displayName: "Acme Chat" },
      },
    ])
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    expect(await screen.findByText("Acme Chat")).toBeInTheDocument()
  })

  it("opens the schema-driven dialog for a contributed kind", async () => {
    mockPluginConnectors.mockReturnValue([
      { pluginId: "acme-chat", type: "acme", def: { type: "acme", displayName: "Acme Chat" } },
    ])
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByTestId("add-adapter-button"))
    fireEvent.click(await screen.findByTestId("add-connector-card-acme"))
    expect(await screen.findByTestId("plugin-connector-dialog")).toHaveTextContent("acme")
  })

  // The Configure button on a row whose plugin was since disabled used to be a
  // no-op; the dialog is what explains the implementation is gone.
  it("still opens a row whose contributing plugin is no longer registered", async () => {
    mockPluginConnectors.mockReturnValue([])
    setupAdapterQueries({
      adapters: [{ ...baseAdapter, id: "px-1", type: "acme", displayName: "Acme prod" }],
    })
    render(<AdaptersTab />)
    fireEvent.click(screen.getByText("Configure"))
    expect(await screen.findByTestId("plugin-connector-dialog")).toHaveTextContent("acme")
  })
})

describe("AdaptersTab — ?platform= landing", () => {
  // Emitted by surfaces that browse the platform CATALOG rather than this
  // list: the Discover connector inspector, the Inbox health popover, the
  // Feishu docs row. Before this the param was written by one call site and
  // read by none, on a `/settings/connections` path that does not exist.

  it("selects the first configured instance of the platform", async () => {
    pendingPlatformValue = "telegram"
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    await waitFor(() => expect(mockSetSelectedAdapterId).toHaveBeenCalledWith("cai_test_1"))
    // Consumed on arrival, so a re-render cannot act on it twice.
    expect(mockClearPendingPlatform).toHaveBeenCalled()
  })

  it("opens the add dialog when that platform has no instance yet", async () => {
    pendingPlatformValue = "matrix"
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    await waitFor(() => expect(screen.getByText(/add matrix connector/i)).toBeInTheDocument())
    expect(mockSetSelectedAdapterId).not.toHaveBeenCalled()
  })

  it("falls back to the picker for a platform with no dialog to open", async () => {
    // A `planned` kind has no factory and no form. The picker at least renders
    // it as a disabled card that explains itself.
    pendingPlatformValue = "kook"
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    await waitFor(() => expect(screen.getByTestId("add-connector-grid")).toBeInTheDocument())
  })

  it("ignores a platform outside the known vocabulary", async () => {
    pendingPlatformValue = "not-a-platform"
    setupAdapterQueries({ adapters: [baseAdapter] })
    render(<AdaptersTab />)
    await waitFor(() => expect(mockClearPendingPlatform).toHaveBeenCalled())
    expect(screen.queryByTestId("add-connector-grid")).not.toBeInTheDocument()
    expect(mockSetSelectedAdapterId).not.toHaveBeenCalled()
  })
})
