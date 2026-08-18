/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { TriggerPolicy } from "@/types/connectors/policy"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
// The shared manual mocks render overlay content unconditionally, so the
// grouped controls are reachable without driving Radix.
jest.mock("@/components/ui/popover")
jest.mock("@/components/ui/dropdown-menu")
jest.mock("@/components/ui/tooltip")
jest.mock("@/lib/db/conversation-overrides", () => ({
  effectiveStatus: (row?: { status?: string }) => row?.status ?? "open",
  setConversationStatus: jest.fn(),
  setConversationAssignee: jest.fn(),
  setConversationLabels: jest.fn(),
}))
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => [],
}))
jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: () => undefined,
  useCharacters: () => [],
}))

// `decideBadge` is mocked below, so the health payload itself is never read.
const mockUseAdapterHealth = jest.fn((_id: string | null | undefined) => ({}) as never)
jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: (id: string | null | undefined) => mockUseAdapterHealth(id),
}))

const mockDecideBadge = jest.fn((_health: unknown): { state: string } | null => null)
jest.mock("./adapter-health-decision", () => ({
  ...jest.requireActual("./adapter-health-decision"),
  decideBadge: (health: unknown) => mockDecideBadge(health),
}))

const mockUseLastInbound = jest.fn<number | null, [unknown?]>(() => null)
jest.mock("@/hooks/connectors/use-last-inbound", () => ({
  useLastInboundForConversation: (key: string | null | undefined) => mockUseLastInbound(key),
}))

const mockUseLatestOutboundJob = jest.fn<
  { id: string; status: string } | null,
  [string | null | undefined]
>(() => null)
jest.mock("@/hooks/connectors/use-latest-outbound-job", () => ({
  useLatestOutboundJob: (key: string | null | undefined) => mockUseLatestOutboundJob(key),
}))
jest.mock("./outbound-status-pill", () => ({
  OutboundStatusPill: ({ conversationKey }: { conversationKey?: string }) => (
    <div data-testid="outbound-status-pill" data-conversation-key={conversationKey} />
  ),
}))

jest.mock("./provider-model-switcher", () => ({
  ProviderModelSwitcher: () => <div data-testid="provider-model-switcher" />,
}))
jest.mock("./quiet-hours-chip", () => ({ QuietHoursChip: () => <div data-testid="quiet-hours" /> }))
jest.mock("./pending-approval-chip", () => ({
  PendingApprovalChip: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="pending-approval-chip" data-session={sessionId} />
  ),
}))
jest.mock("./at-strategy-chip", () => ({ AtStrategyChip: () => <div data-testid="at-strategy" /> }))
jest.mock("./topic-runtime-chip", () => ({
  TopicRuntimeChip: () => <div data-testid="topic-runtime" />,
}))
jest.mock("./adapter-health-badge", () => ({
  AdapterHealthBadge: () => <div data-testid="adapter-health-badge" />,
}))
jest.mock("./overrides/computer-use-toggle", () => ({
  ComputerUseToggle: () => <div data-testid="computer-use-toggle" />,
}))

// "Open in chat": the shared ⌘K focus primitive + the session hook's `select`
// + the router. All three are seams here; their behaviour is covered in their
// own suites.
const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), prefetch: jest.fn() }),
}))
const mockSelect = jest.fn()
jest.mock("@/hooks/chat/use-sessions", () => ({ useSessions: () => ({ select: mockSelect }) }))
const mockFocusSession = jest.fn()
jest.mock("@/hooks/global-search/use-global-search-actions", () => ({
  focusSession: (...args: unknown[]) => mockFocusSession(...args),
}))
const mockGetSession = jest.fn(async (_id: string) => undefined as unknown)
jest.mock("@/lib/db/sessions", () => ({ getSession: (id: string) => mockGetSession(id) }))

import { ConversationHeaderOverflow, hasOverflowAttention } from "./conversation-header-overflow"

const EMPTY_POLICY: TriggerPolicy = {
  rules: [],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}
const CK = "telegram:a1:c1"

function renderOverflow(
  props: Partial<React.ComponentProps<typeof ConversationHeaderOverflow>> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ConversationHeaderOverflow
        conversationKey={CK}
        sessionId="s1"
        adapterId="a1"
        policy={EMPTY_POLICY}
        desktop={false}
        onOpenContact={jest.fn()}
        onOpenBindings={jest.fn()}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDecideBadge.mockReturnValue(null)
  mockUseLastInbound.mockReturnValue(null)
  mockUseLatestOutboundJob.mockReturnValue(null)
})

describe("hasOverflowAttention", () => {
  const row = (over: Partial<ConversationOverrideRow>) => over as ConversationOverrideRow

  it("is quiet for an untouched conversation", () => {
    expect(hasOverflowAttention(undefined, false)).toBe(false)
    expect(hasOverflowAttention(row({}), false)).toBe(false)
  })

  it("flags a degraded adapter", () => {
    expect(hasOverflowAttention(undefined, true)).toBe(true)
  })

  it("flags a non-open lifecycle status", () => {
    expect(hasOverflowAttention(row({ status: "pending" }), false)).toBe(true)
    expect(hasOverflowAttention(row({ status: "open" }), false)).toBe(false)
  })

  it("flags an assignee", () => {
    expect(hasOverflowAttention(row({ assignee: { id: "u1" } as never }), false)).toBe(true)
  })

  it("flags labels, but not an empty label array", () => {
    expect(hasOverflowAttention(row({ labelIds: ["vip"] }), false)).toBe(true)
    expect(hasOverflowAttention(row({ labelIds: [] }), false)).toBe(false)
  })

  // A high-blast-radius opt-in must never be silently on behind a closed menu.
  it("flags a failed / dead-lettered / ambiguous newest outbound job, not a healthy one", () => {
    for (const status of ["failed", "deadlettered", "delivery_unknown"] as const) {
      expect(hasOverflowAttention(undefined, false, status)).toBe(true)
    }
    for (const status of ["pending", "sending", "sent"] as const) {
      expect(hasOverflowAttention(undefined, false, status)).toBe(false)
    }
    expect(hasOverflowAttention(undefined, false, null)).toBe(false)
    expect(hasOverflowAttention(undefined, false, undefined)).toBe(false)
  })

  it("flags an active computer-use opt-in", () => {
    expect(hasOverflowAttention(row({ allowComputerUse: true }), false)).toBe(true)
    expect(hasOverflowAttention(row({ allowComputerUse: false }), false)).toBe(false)
  })
})

describe("ConversationHeaderOverflow", () => {
  it("exposes a labelled trigger", () => {
    renderOverflow()
    expect(screen.getByTestId("conversation-header-more")).toHaveAttribute("aria-label", "More")
  })

  it("raises an attention dot and relabels when something needs attention", () => {
    renderOverflow({ overrideRow: { status: "pending" } as ConversationOverrideRow })
    expect(screen.getByTestId("conversation-header-more-dot")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-header-more")).toHaveAttribute(
      "aria-label",
      "More — needs attention"
    )
  })

  it("stays undotted while everything is at its default", () => {
    renderOverflow()
    expect(screen.queryByTestId("conversation-header-more-dot")).not.toBeInTheDocument()
  })

  // The dot has to reflect adapter health with the popover closed, which is why
  // the overflow resolves health itself instead of leaving it to the badge.
  it("raises the dot for a degraded adapter", () => {
    mockDecideBadge.mockReturnValue({ state: "down" })
    renderOverflow()
    expect(screen.getByTestId("conversation-header-more-dot")).toBeInTheDocument()
  })

  it("groups status, routing, health and tooling", () => {
    renderOverflow()
    for (const label of ["Status", "Routing", "Health", "Tools"]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it("shows the read-only computer-use chip on web and the toggle on desktop", () => {
    const { unmount } = renderOverflow({ desktop: false })
    expect(screen.queryByTestId("computer-use-toggle")).not.toBeInTheDocument()
    unmount()

    renderOverflow({ desktop: true })
    expect(screen.getByTestId("computer-use-toggle")).toBeInTheDocument()
  })

  it("mounts the pending-approval chip in the status group for the conversation session", () => {
    renderOverflow({ desktop: true })
    expect(screen.getByTestId("pending-approval-chip")).toBeInTheDocument()
    expect(screen.getByTestId("pending-approval-chip")).toHaveAttribute("data-session")
  })

  it("keeps desktop-only routing and diagnostics off the web build", () => {
    renderOverflow({ desktop: false })
    expect(screen.queryByTestId("provider-model-switcher")).not.toBeInTheDocument()
    expect(screen.queryByTestId("conversation-header-bindings")).not.toBeInTheDocument()
  })

  it("mounts the desktop routing and diagnostics surfaces", () => {
    renderOverflow({ desktop: true })
    expect(screen.getByTestId("provider-model-switcher")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-header-bindings")).toBeInTheDocument()
  })

  // `parseConversationKey` yields "" for an unparseable key; adapter-scoped
  // surfaces must not mount against an empty id.
  it("omits adapter-scoped surfaces when the adapter id is unparseable", () => {
    renderOverflow({ adapterId: "", desktop: true })
    expect(screen.queryByTestId("adapter-health-badge")).not.toBeInTheDocument()
    expect(screen.queryByTestId("quiet-hours")).not.toBeInTheDocument()
    expect(screen.queryByTestId("at-strategy")).not.toBeInTheDocument()
    expect(screen.queryByTestId("topic-runtime")).not.toBeInTheDocument()
    expect(screen.queryByTestId("conversation-header-bindings")).not.toBeInTheDocument()
  })

  it("routes the contact and bindings triggers back to the header", async () => {
    const onOpenContact = jest.fn()
    const onOpenBindings = jest.fn()
    renderOverflow({ desktop: true, onOpenContact, onOpenBindings })

    await userEvent.click(screen.getByTestId("conversation-header-contact"))
    expect(onOpenContact).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId("conversation-header-bindings"))
    expect(onOpenBindings).toHaveBeenCalledTimes(1)
  })

  it("opens the conversation in the main chat: focus via the shared primitive, then home", async () => {
    const row = { id: "s1", projectId: "p1", kind: "direct" }
    mockGetSession.mockResolvedValueOnce(row)
    renderOverflow()
    await userEvent.click(screen.getByTestId("conversation-header-open-in-chat"))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/"))
    expect(mockGetSession).toHaveBeenCalledWith("s1")
    expect(mockFocusSession).toHaveBeenCalledWith(row, "s1", mockSelect)
    // Focus happens before the route change.
    expect(mockFocusSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockPush.mock.invocationCallOrder[0]!
    )
  })

  it("still opens the main chat when the session row cannot be read", async () => {
    mockGetSession.mockResolvedValueOnce(undefined)
    renderOverflow()
    await userEvent.click(screen.getByTestId("conversation-header-open-in-chat"))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/"))
    expect(mockFocusSession).toHaveBeenCalledWith(undefined, "s1", mockSelect)
  })

  it("renders the last-inbound chip inside the status group", () => {
    mockUseLastInbound.mockReturnValue(Date.now() - 5 * 60_000)
    renderOverflow()
    expect(screen.getByTestId("conversation-header-last-inbound")).toBeInTheDocument()
  })

  it("mounts the delivery-status pill for this conversation inside the health group", () => {
    renderOverflow()
    const pill = screen.getByTestId("outbound-status-pill")
    expect(pill).toHaveAttribute("data-conversation-key", CK)
    expect(mockUseLatestOutboundJob).toHaveBeenCalledWith(CK)
  })

  it("omits the pill together with the health group when the adapter id is unparseable", () => {
    renderOverflow({ adapterId: "" })
    expect(screen.queryByTestId("outbound-status-pill")).not.toBeInTheDocument()
  })

  // The dot must reflect a failed delivery while the popover is closed, so the
  // overflow resolves the newest outbound job itself.
  it("raises the dot for a failed newest outbound job and stays quiet for a sent one", () => {
    mockUseLatestOutboundJob.mockReturnValue({ id: "j1", status: "failed" })
    const { unmount } = renderOverflow()
    expect(screen.getByTestId("conversation-header-more-dot")).toBeInTheDocument()
    unmount()
    mockUseLatestOutboundJob.mockReturnValue({ id: "j2", status: "sent" })
    renderOverflow()
    expect(screen.queryByTestId("conversation-header-more-dot")).not.toBeInTheDocument()
  })
})
