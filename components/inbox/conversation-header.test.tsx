/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockBack = jest.fn()
const mockPush = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: mockBack }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox",
  redirect: jest.fn(),
}))

jest.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({
    className,
    "data-testid": testId,
    "aria-label": ariaLabel,
  }: {
    className?: string
    "data-testid"?: string
    "aria-label"?: string
  }) => <button type="button" data-testid={testId} aria-label={ariaLabel} className={className} />,
}))

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/db/conversation-overrides", () => ({
  upsertByConversationKey: jest.fn().mockResolvedValue({}),
  effectiveStatus: jest.fn().mockReturnValue("open"),
  setStatus: jest.fn().mockResolvedValue(undefined),
  setAssignee: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/components/ui/dropdown-menu")
// Everything that is not identity / mode lives behind the header's `⋯`
// popover now. The shared manual mock renders `PopoverContent`
// unconditionally, so these tests keep reaching the controls directly.
// (The chrome-budget assertion needs the opposite and lives in
// `conversation-header.budget.test.tsx`.)
jest.mock("@/components/ui/popover")

jest.mock("@/components/ui/tooltip")

const mockUseCharacter = jest.fn()
jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: (id: string | null | undefined) => mockUseCharacter(id),
  useCharacters: () => [],
}))

jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => [],
}))

jest.mock("./contact-profile-drawer", () => ({
  ContactProfileDrawer: () => null,
}))

// Typed loose so per-test `mockReturnValue` calls can vary the `current.state`
// without TS narrowing it to the initial "running" literal.
const mockUseAdapterHealth = jest.fn<unknown, [unknown?]>(() => ({
  current: { state: "running", reason: undefined as string | undefined, lastActivityAt: 0 },
  buckets: [] as unknown[],
  lastOk: undefined as unknown,
  lastError: undefined as unknown,
  pendingOutboundCount: 0,
  breaker: null as unknown,
  rateBucket: null as unknown,
  atGateBlocks: { total: 0, byReason: [] as unknown[] },
}))
jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: (id: string | null | undefined) => mockUseAdapterHealth(id),
}))

const mockWriteRoute = jest.fn<string, []>(() => "local")
jest.mock("@/lib/connectors/inbox-writes", () => ({
  useInboxWriteRoute: () => mockWriteRoute(),
  mutateConversationOverride: jest.fn().mockResolvedValue({ route: "local" }),
}))

// The chip's vocabulary is the four presets, resolved from the axes. Stubbing
// the resolver keeps this suite about the header's own wiring, which is what
// preset it hands down and whether it hands down a live control at all.
/**
 * The header reads the axes and the target; the override dialog it mounts
 * reads the provenance of every field. Build the whole shape from one helper
 * so a test that only cares about the axes cannot half-populate it and take
 * the dialog down with it.
 */
function effectiveConfigStub(
  patch: {
    autonomy?: string
    engagement?: string
    target?: { kind: string; id?: string }
  } = {}
) {
  const src = (source = "adapter-default") => ({ source })
  return {
    autonomy: { effective: patch.autonomy ?? "act", ...src() },
    engagement: { effective: patch.engagement ?? "inline", ...src() },
    authority: { effective: undefined, ...src("system-default") },
    mode: { effective: "auto", ...src() },
    target: { effective: patch.target ?? { kind: "direct" }, ...src("system-default") },
    character: { effective: undefined, ...src("system-default") },
    behavior: {
      inboundActivationPolicy: { effective: "mention_activates", ...src("system-default") },
      activeRunDispatchMode: { effective: "queue", ...src("system-default") },
      activationTtlMs: { effective: undefined, ...src("system-default") },
    },
  }
}

const mockEffectiveConfig = jest.fn<unknown, [unknown?]>(() => effectiveConfigStub())
jest.mock("@/hooks/connectors/use-im-effective-config", () => ({
  useImEffectiveConfig: (input: unknown) => mockEffectiveConfig(input),
}))

const mockUseLastInbound = jest.fn<number | null, [unknown?]>(() => null)
jest.mock("@/hooks/connectors/use-last-inbound", () => ({
  useLastInboundForConversation: (key: string | null | undefined) => mockUseLastInbound(key),
}))

const mockRequeueAdapter = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/connectors/lifecycle", () => ({
  requeueAdapter: (...args: unknown[]) => mockRequeueAdapter(...args),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

// Stub the inspector so the header test doesn't pull in Dexie / the bus — the
// inspector's own behaviour is covered by its co-located test. We only verify
// the header mounts it and the trigger toggles `open`.
jest.mock("./debug/callback-bindings-inspector", () => ({
  CallbackBindingsInspector: ({ open }: { open: boolean }) =>
    open ? <div data-testid="bindings-inspector-open" /> : null,
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { ConversationHeader } from "./conversation-header"
import { isTauri } from "@/lib/tauri"
import type { TriggerPolicy } from "@/types/connectors/policy"

const EMPTY_POLICY: TriggerPolicy = {
  rules: [],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

beforeEach(() => {
  ;(isTauri as jest.Mock).mockReturnValue(false)
  mockUseCharacter.mockReturnValue(undefined)
  mockBack.mockReset()
  mockPush.mockReset()
  mockRequeueAdapter.mockReset()
  mockRequeueAdapter.mockResolvedValue(true)
  mockUseLastInbound.mockReset()
  mockUseLastInbound.mockReturnValue(null)
  mockWriteRoute.mockReset()
  mockWriteRoute.mockReturnValue("local")
  mockEffectiveConfig.mockReset()
  mockEffectiveConfig.mockReturnValue(effectiveConfigStub())
  mockUseAdapterHealth.mockReturnValue({
    current: { state: "running", reason: undefined, lastActivityAt: 0 },
    buckets: [],
    lastOk: undefined,
    lastError: undefined,
    pendingOutboundCount: 0,
    breaker: null,
    rateBucket: null,
  })
})

describe("ConversationHeader", () => {
  it("renders the conversation title", () => {
    render(
      <ConversationHeader
        conversationKey="ck1"
        sessionId="s1"
        title="My Telegram Chat"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.getByText("My Telegram Chat")).toBeInTheDocument()
  })

  it("renders the artifact dock toggle without a breakpoint gate", () => {
    // This header is the ONLY standing opener for the dock on `/inbox/c` — the
    // chat pane below mounts with `showHeader={false}`, and the AppShellMobile
    // top bar (the other opener) isn't mounted on this route. A `hidden
    // md:inline-flex` class therefore left phones with no way to open the dock
    // at all.
    render(
      <ConversationHeader
        conversationKey="ck-dock"
        sessionId="s-dock"
        title="Dock"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    const toggle = screen.getByTestId("chat-artifact-dock-toggle")
    expect(toggle).toBeInTheDocument()
    expect(toggle.className).not.toContain("hidden")
  })

  // The chip names the preset the stored axes add up to, not the legacy
  // three-value mirror. `observe` + `human` is `silent`.
  it("renders the live behaviour chip with the resolved preset", () => {
    mockEffectiveConfig.mockReturnValue(
      effectiveConfigStub({ autonomy: "observe", engagement: "human" })
    )
    render(
      <ConversationHeader
        conversationKey="ck2"
        sessionId="s2"
        title="Test"
        platform="discord"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.getByTestId("mode-switcher-trigger")).toHaveAttribute("data-selection", "silent")
  })

  // A team-bound conversation runs in the background, which is `delegate`. The
  // header has to pass the target down or the chip would call this `assistant`
  // and offer to un-delegate it by accident.
  it("passes the effective target down so delegate is reachable", () => {
    mockEffectiveConfig.mockReturnValue(
      effectiveConfigStub({
        engagement: "background",
        target: { kind: "team", id: "t1" },
      })
    )
    render(
      <ConversationHeader
        conversationKey="ck2b"
        sessionId="s2b"
        title="Test"
        platform="discord"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.getByTestId("mode-switcher-trigger")).toHaveAttribute(
      "data-selection",
      "delegate"
    )
    expect(screen.getByTestId("mode-option-delegate")).not.toBeDisabled()
  })

  it("renders the policy info chip", () => {
    render(
      <ConversationHeader
        conversationKey="ck3"
        sessionId="s3"
        title="Test"
        platform="slack"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.getByTestId("policy-info-trigger")).toBeInTheDocument()
  })

  // Only a shell with nowhere to send the write gets the read-only badge. The
  // gate used to be `isTauri()`, which disabled the control on a paired phone
  // whose write `mutateConversationOverride` would have relayed just fine.
  it("renders a static disabled badge only when the write has no route", () => {
    mockWriteRoute.mockReturnValue("unavailable")
    render(
      <ConversationHeader
        conversationKey="ck4"
        sessionId="s4"
        title="Web test"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    const disabled = screen.getByTestId("mode-switcher-disabled")
    expect(disabled).toHaveAttribute("aria-disabled", "true")
    expect(disabled).toHaveTextContent("Assistant")
    // The live dropdown trigger must not render — that was the bug we fixed
    // (Radix portals the menu past the pointer-events-none wrapper).
    expect(screen.queryByTestId("mode-switcher-trigger")).not.toBeInTheDocument()
  })

  it.each(["local", "remote"])("renders the live chip on a %s write route", (route) => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    mockWriteRoute.mockReturnValue(route)
    render(
      <ConversationHeader
        conversationKey="ck5"
        sessionId="s5"
        title="Routed test"
        platform="discord"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.queryByTestId("mode-switcher-disabled")).not.toBeInTheDocument()
    expect(screen.getByTestId("mode-switcher-trigger")).toBeInTheDocument()
  })

  it("renders the character chip when a character is bound", () => {
    mockUseCharacter.mockReturnValue({ id: "c1", name: "Ada" })
    render(
      <ConversationHeader
        conversationKey="ck6"
        sessionId="s6"
        title="Character chat"
        platform="telegram"
        policy={EMPTY_POLICY}
        characterId="c1"
      />
    )
    expect(screen.getByTestId("conversation-character-chip")).toBeInTheDocument()
    expect(screen.getByText("Ada")).toBeInTheDocument()
  })

  it("omits the character chip when no character is bound", () => {
    mockUseCharacter.mockReturnValue(undefined)
    render(
      <ConversationHeader
        conversationKey="ck7"
        sessionId="s7"
        title="No character"
        platform="discord"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.queryByTestId("conversation-character-chip")).not.toBeInTheDocument()
  })

  it("renders the mobile back button and the mobile sidebar trigger", () => {
    render(
      <ConversationHeader
        conversationKey="ck8"
        sessionId="s8"
        title="Mobile chrome"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    const back = screen.getByTestId("conversation-header-back")
    const trigger = screen.getByTestId("conversation-header-open-sidebar")
    expect(back).toBeInTheDocument()
    expect(trigger).toBeInTheDocument()
    expect(back).toHaveClass("md:hidden")
    expect(trigger).toHaveClass("md:hidden")
    // i18n keys: backToList / openSidebar — both are wired so the
    // accessible name reflects the localized string.
    expect(back).toHaveAccessibleName(/back to conversation list/i)
    expect(trigger).toHaveAccessibleName(/open sidebar/i)
  })

  it("back button calls router.back() when history has more than one entry", () => {
    // jsdom defaults to history.length === 1 — push an extra state so back()
    // is the chosen branch.
    window.history.pushState({}, "", "/inbox/c/ck-prev")
    expect(window.history.length).toBeGreaterThan(1)

    render(
      <ConversationHeader
        conversationKey="ck9"
        sessionId="s9"
        title="Back test"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )

    fireEvent.click(screen.getByTestId("conversation-header-back"))
    expect(mockBack).toHaveBeenCalledTimes(1)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("back button falls back to router.push('/inbox') when no history is available", () => {
    // Spy on history.length to force the fallback branch — directly setting
    // window.history.length isn't reliable across jsdom versions.
    const lengthSpy = jest.spyOn(window.history, "length", "get").mockReturnValue(1)

    render(
      <ConversationHeader
        conversationKey="ck10"
        sessionId="s10"
        title="Deep-link test"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )

    fireEvent.click(screen.getByTestId("conversation-header-back"))
    expect(mockPush).toHaveBeenCalledWith("/inbox")
    expect(mockBack).not.toHaveBeenCalled()

    lengthSpy.mockRestore()
  })
})

describe("ConversationHeader — adapter degradation badge (Task 2.4)", () => {
  // parseConversationKey expects platform:adapterId:chatId — supply a valid
  // shape so parsedAdapterId is non-empty and the badge mounts.
  const conversationKey = "telegram:adp-1:12345"

  it("does not render the degraded badge when adapter is running", () => {
    mockUseAdapterHealth.mockReturnValue({
      current: { state: "running", reason: undefined, lastActivityAt: 0 },
      buckets: [],
      lastOk: undefined,
      lastError: undefined,
      pendingOutboundCount: 0,
      breaker: null,
      rateBucket: null,
    })
    render(
      <ConversationHeader
        conversationKey={conversationKey}
        sessionId="s-running"
        title="Healthy"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.queryByTestId("adapter-health-badge")).not.toBeInTheDocument()
  })

  it("renders the degraded badge with the localized state when adapter is down", () => {
    mockUseAdapterHealth.mockReturnValue({
      current: { state: "down", reason: "transport closed", lastActivityAt: 0 },
      buckets: [],
      lastOk: undefined,
      lastError: undefined,
      pendingOutboundCount: 0,
      breaker: null,
      rateBucket: null,
    })
    render(
      <ConversationHeader
        conversationKey={conversationKey}
        sessionId="s-down"
        title="Offline"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    const badge = screen.getByTestId("adapter-health-badge")
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent(/offline/i)
  })

  it("renders the degraded badge for degraded state", () => {
    mockUseAdapterHealth.mockReturnValue({
      current: { state: "degraded", reason: "5xx run", lastActivityAt: 0 },
      buckets: [],
      lastOk: undefined,
      lastError: undefined,
      pendingOutboundCount: 0,
      breaker: null,
      rateBucket: null,
    })
    render(
      <ConversationHeader
        conversationKey={conversationKey}
        sessionId="s-deg"
        title="Degraded"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.getByTestId("adapter-health-badge")).toBeInTheDocument()
  })

  it("renders the last-inbound chip when the hook returns a timestamp (Task P2.5)", () => {
    mockUseLastInbound.mockReturnValue(Date.now() - 5 * 60_000)
    render(
      <ConversationHeader
        conversationKey={conversationKey}
        sessionId="s-li"
        title="Last inbound test"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    const chip = screen.getByTestId("conversation-header-last-inbound")
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toMatch(/min/i)
  })

  it("hides the last-inbound chip when no inbound has been seen", () => {
    mockUseLastInbound.mockReturnValue(null)
    render(
      <ConversationHeader
        conversationKey={conversationKey}
        sessionId="s-li-none"
        title="Empty inbox"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.queryByTestId("conversation-header-last-inbound")).not.toBeInTheDocument()
  })

  it("clicking Reconnect calls requeueAdapter with the parsed adapter id", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    mockUseAdapterHealth.mockReturnValue({
      current: { state: "down", reason: undefined, lastActivityAt: 0 },
      buckets: [],
      lastOk: undefined,
      lastError: undefined,
      pendingOutboundCount: 0,
      breaker: null,
      rateBucket: null,
    })
    render(
      <ConversationHeader
        conversationKey={conversationKey}
        sessionId="s-rec"
        title="Reconnect test"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    fireEvent.click(screen.getByTestId("adapter-health-badge"))
    const reconnect = await screen.findByTestId("adapter-health-reconnect")
    fireEvent.click(reconnect)
    await new Promise((r) => setTimeout(r, 0))
    expect(mockRequeueAdapter).toHaveBeenCalledWith("adp-1")
  })
})

describe("ConversationHeader — callback-bindings inspector (B3)", () => {
  const conversationKey = "telegram:adp-1:12345"

  it("renders the inspector trigger on desktop and opens it on click", () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    render(
      <ConversationHeader
        conversationKey={conversationKey}
        sessionId="s-bind"
        title="Bindings"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    const trigger = screen.getByTestId("conversation-header-bindings")
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveAccessibleName(/bindings inspector/i)
    // Closed until clicked.
    expect(screen.queryByTestId("bindings-inspector-open")).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.getByTestId("bindings-inspector-open")).toBeInTheDocument()
  })

  it("does not render the inspector trigger in web mode", () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    render(
      <ConversationHeader
        conversationKey={conversationKey}
        sessionId="s-bind-web"
        title="Bindings web"
        platform="telegram"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.queryByTestId("conversation-header-bindings")).not.toBeInTheDocument()
  })
})
