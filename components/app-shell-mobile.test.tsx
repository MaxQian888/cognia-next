/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatSession } from "@cognia/agent-config-types"
import type { SelectedGuild } from "@/stores/ui"

const logInfo = jest.fn()
const logWarn = jest.fn()
jest.mock("@/components/chat/shared-session-panel", () => ({
  SharedSessionPanel: ({ session }: { session: { id: string } }) => (
    <div data-testid="shared-mobile-controls">{session.id}</div>
  ),
}))
jest.mock("@/components/chat/shared-session-join", () => ({
  SharedSessionJoin: () => <div data-testid="shared-mobile-join" />,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: { default?: string }) => opts?.default ?? key,
  // The always-mounted global search dialog (ADR-0129) reads the locale and a
  // stable "now" for recency scoring.
  useLocale: () => "en",
  useNow: () => new Date(1700000000000),
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}))

jest.mock("@cognia/logging", () => {
  // Namespace-agnostic. Listing only the `loggers.*` names a suite happens to
  // reach means the day an import chain grows a new one the whole file dies at
  // load and zero tests run.
  const child: Record<string, unknown> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  }
  child.child = () => child
  return {
    createLogger: () => child,
    logger: child,
    loggers: new Proxy({} as Record<string, unknown>, { get: () => child }),
  }
})

const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), info: jest.fn(), success: jest.fn() },
}))

const sessionsRef: { current: ChatSession[] } = { current: [] }
const select = jest.fn()
const create = jest.fn()
const remove = jest.fn().mockResolvedValue(undefined)
const rename = jest.fn()
const archive = jest.fn()
const unarchive = jest.fn()
const bulkSetPinned = jest.fn()
const assignToFolder = jest.fn()
const isLoadingSessionsRef = { current: false }
const directSend = jest.fn().mockResolvedValue(undefined)
const teamSend = jest.fn().mockResolvedValue(undefined)
let activeSessionId: string | null = null
jest.mock("@/hooks/chat", () => ({
  useSessions: () => ({
    sessions: sessionsRef.current,
    isLoadingSessions: isLoadingSessionsRef.current,
    activeSessionId,
    select,
    create,
    remove,
    rename,
    archive,
    unarchive,
    bulkSetPinned,
    assignToFolder,
    folders: [],
  }),
  useClaudeChat: () => ({
    send: directSend,
    stop: jest.fn(),
    regenerate: jest.fn(),
    editAndResend: jest.fn(),
    respondToApproval: jest.fn(),
  }),
  useTeamChat: () => ({
    send: teamSend,
    stop: jest.fn(),
    regenerate: jest.fn(),
    editAndResend: jest.fn(),
    respondToApproval: jest.fn(),
  }),
}))

const errorMessageRef: { current: string | null } = { current: null }
const setPermissionMode = jest.fn()
const clearActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T,>(
      selector: (s: {
        errorMessage: string | null
        status: string
        pendingApprovals: unknown[]
        activeSessionEpoch: number
        clearActiveSession: typeof clearActiveSession
      }) => T
    ): T =>
      selector({
        errorMessage: errorMessageRef.current,
        status: "idle",
        pendingApprovals: [],
        activeSessionEpoch: 0,
        clearActiveSession,
      }),
    { getState: () => ({ setPermissionMode }) }
  ),
}))

const updateSession = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/sessions", () => ({
  updateSession: (...a: unknown[]) => updateSession(...a),
}))

const loadSettings = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    <T,>(selector: (s: { load: typeof loadSettings }) => T): T => selector({ load: loadSettings }),
    { getState: () => ({ settings: { apiKey: "k" } }) }
  ),
}))

let selectedGuild: SelectedGuild = { kind: "dm" }
const setSelectedGuild = jest.fn((g: SelectedGuild) => {
  selectedGuild = g
})
const pendingSettingsRequestRef: { current: { tab?: string; nonce: number } | null } = {
  current: null,
}
const clearPendingSettings = jest.fn()
const requestChatHome = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(
    selector: (s: {
      selectedGuild: SelectedGuild
      setSelectedGuild: typeof setSelectedGuild
      pendingSettingsRequest: typeof pendingSettingsRequestRef.current
      clearPendingSettings: typeof clearPendingSettings
      requestChatHome: typeof requestChatHome
      chatHomeEpoch: number
      selectedGuildEpoch: number
    }) => T
  ): T =>
    selector({
      selectedGuild,
      setSelectedGuild,
      pendingSettingsRequest: pendingSettingsRequestRef.current,
      clearPendingSettings,
      requestChatHome,
      chatHomeEpoch: 0,
      selectedGuildEpoch: 0,
    }),
}))

jest.mock("@/lib/db/schema", () => ({
  whenSeeded: jest.fn().mockResolvedValue(undefined),
  getDb: () => ({
    inboundLedger: { where: () => ({ above: () => ({ count: async () => 0 }) }) },
    chatSearchState: {
      get: async () => ({
        id: "singleton",
        oldestProjectedAt: null,
        oldestProjectedId: null,
        complete: true,
        updatedAt: 0,
      }),
    },
  }),
}))

jest.mock("@/lib/db/session-state", () => ({
  getSessionState: jest.fn().mockResolvedValue(undefined),
  markSessionRead: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/db/characters", () => ({
  listCharacters: () => Promise.resolve([]),
}))

jest.mock("@/lib/db/teams", () => ({
  getTeam: () => Promise.resolve(undefined),
}))

const inboxUnreadRef = { current: 0 }
const shellCharacters = [{ id: "c1", name: "Octo" }]
const useDexieFirstQuery = jest.fn((_opts: { table?: string }) => ({ data: shellCharacters }))
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(query: () => Promise<T>, _deps: unknown, fallback: T): T =>
    query.toString().includes("loadMobileUnread") ? (inboxUnreadRef.current as T) : fallback,
  useDexieFirstQuery: (opts: { table?: string }) => useDexieFirstQuery(opts),
}))

// The drawer list's long-lived source. A passthrough: the shell test pins that
// it wraps the drawer and gets the shell's characters.
const sourceCharactersRef: { current: unknown } = { current: undefined }
jest.mock("@/components/mobile/shell/mobile-channel-list-source", () => ({
  MobileChannelListSourceProvider: ({
    characters,
    children,
  }: {
    characters: unknown
    children: React.ReactNode
  }) => {
    sourceCharactersRef.current = characters
    return <div data-testid="channel-list-source">{children}</div>
  },
}))

// Same send gate the desktop workspace applies.
const runtimeGateRef: {
  current: {
    composerDisabled: boolean
    availability: { state: string; reason: string }
    recovery: { kind: string }
    connecting: boolean
  }
} = {
  current: {
    composerDisabled: false,
    availability: { state: "available", reason: "local-host" },
    recovery: { kind: "none" },
    connecting: false,
  },
}
jest.mock("@/hooks/chat/use-chat-runtime-gate", () => ({
  useChatRuntimeGate: () => runtimeGateRef.current,
}))
jest.mock("@/components/mobile/shell/mobile-chat-runtime-notice", () => ({
  MobileChatRuntimeNotice: () => <div data-testid="mobile-chat-runtime-notice" />,
}))
jest.mock("@/components/mobile/shell/mobile-credential-warning", () => ({
  MobileCredentialWarning: ({
    showLabel,
    onResolve,
  }: {
    showLabel: boolean
    onResolve: () => void
  }) => (
    <button
      type="button"
      data-testid="mobile-no-api-key"
      data-show-label={showLabel ? "true" : "false"}
      onClick={onResolve}
    />
  ),
}))

// Stub heavy children — the shell test verifies structural wiring, not
// child internals.
const welcomeExtrasRef: {
  current: {
    hideSamples?: boolean
    hideNewChatAction?: boolean
    quickActions?: React.ReactNode
    header?: React.ReactNode
  } | null
} = { current: null }
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: ({
    showHeader,
    onSend,
    onResumeAfterPlanApproval,
    welcomeExtras,
    composerDisabled,
    runtimeNotice,
    heroRouting,
  }: {
    heroRouting?: boolean
    composerDisabled?: boolean
    runtimeNotice?: React.ReactNode
    showHeader?: boolean
    welcomeExtras?: typeof welcomeExtrasRef.current
    onSend?: (
      content: unknown,
      manifest?: readonly [{ filename: string; mediaType: string; kind: "document" }],
      templateRun?: unknown,
      turnMetadata?: unknown
    ) => Promise<void>
    onResumeAfterPlanApproval?: (prompt: string, mode: string) => void | Promise<void>
  }) => {
    welcomeExtrasRef.current = welcomeExtras ?? null
    return (
      <div
        data-testid="chat-pane"
        data-show-header={showHeader === false ? "false" : "true"}
        data-has-plan-resume={onResumeAfterPlanApproval ? "true" : "false"}
        data-composer-disabled={composerDisabled ? "true" : "false"}
        data-hero-routing={String(heroRouting)}
      >
        {runtimeNotice}
        <button
          data-testid="chat-send-stub"
          onClick={() => {
            void onSend?.("hi", [
              { filename: "report.txt", mediaType: "text/plain", kind: "document" },
            ]).catch(() => {})
          }}
        />
        <button
          data-testid="chat-send-web-stub"
          onClick={() => {
            void onSend?.("web", undefined, null, {
              webSearchContext: {
                provider: "tavily",
                results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
              },
            }).catch(() => {})
          }}
        />
        <button
          data-testid="chat-plan-resume-stub"
          onClick={() => {
            void onResumeAfterPlanApproval?.("go", "acceptEdits")
          }}
        />
      </div>
    )
  },
}))

const hapterImpact = jest.fn()
const hapterNotify = jest.fn()
jest.mock("@/lib/capacitor/haptics", () => ({
  impact: (...a: unknown[]) => hapterImpact(...a),
  notify: (...a: unknown[]) => hapterNotify(...a),
}))
// gap11 — stub the artifact dock (its real import chain pulls the editor/LSP
// modules). Render children inside a marker so we can assert it wraps the chat.
jest.mock("@/components/artifacts/artifact-workspace-dock", () => ({
  ArtifactWorkspaceDock: ({ children }: { children?: import("react").ReactNode }) => (
    <div data-testid="artifact-workspace-dock">{children}</div>
  ),
}))
jest.mock("@/components/chat/character-picker", () => ({
  CharacterPicker: ({ open }: { open: boolean }) =>
    open ? <div data-testid="char-picker" /> : null,
}))
jest.mock("@/components/chat/tool-approval-dialog", () => ({
  ToolApprovalDialog: () => null,
}))
jest.mock("@/components/shell/guild-rail", () => ({
  GuildRail: ({
    onCreateTeam,
    onOpenSettings,
    variant,
  }: {
    onCreateTeam: () => void
    onOpenSettings: () => void
    variant?: string
  }) => (
    <div data-testid="guild-rail" data-variant={variant ?? "rail"}>
      <button data-testid="guild-create-team" onClick={onCreateTeam} />
      <button data-testid="guild-open-settings" onClick={onOpenSettings} />
    </div>
  ),
}))
jest.mock("@/components/data/export/single-export-dialog", () => ({
  SingleExportDialog: ({ open, session }: { open?: boolean; session?: { id: string } }) =>
    open ? <div data-testid="single-export-dialog">{session?.id}</div> : null,
}))

jest.mock("@/components/chat/session-settings-sheet", () => ({
  SessionSettingsSheet: ({
    open,
    session,
    showAmbientStatus,
  }: {
    open?: boolean
    session?: { id: string }
    showAmbientStatus?: boolean
  }) =>
    open ? (
      <div data-testid="session-settings-sheet" data-ambient={showAmbientStatus ? "1" : "0"}>
        {session?.id}
      </div>
    ) : null,
}))

const credentialStatusRef: { current: { keyOk: boolean | null; plan: string | null } } = {
  current: { keyOk: true, plan: null },
}
jest.mock("@/hooks/chat/use-credential-status", () => ({
  useCredentialStatus: () => credentialStatusRef.current,
}))

const channelListPropsRef: { current: Record<string, unknown> | null } = { current: null }
jest.mock("@/components/mobile/shell/mobile-channel-list", () => ({
  MobileChannelList: (props: { onSelect: (id: string) => void; onNewDirect: () => void }) => {
    channelListPropsRef.current = props as unknown as Record<string, unknown>
    return (
      <div>
        <button data-testid="channel-select-stub" onClick={() => props.onSelect("s-2")} />
        <button data-testid="channel-new-direct-stub" onClick={props.onNewDirect} />
        {/* A row owns its horizontal drags (see <SwipeRow>). */}
        <div data-swipe-row="" data-testid="channel-row-stub" />
        <div data-testid="channel-body-stub" />
      </div>
    )
  },
}))

jest.mock("@/components/mobile/shell/character-header", () => ({
  CharacterHeader: ({
    subject,
    fallbackTitle,
  }: {
    subject: { name: string } | null
    fallbackTitle: string
  }) => <div data-testid="mobile-active-title">{subject?.name ?? fallbackTitle}</div>,
}))
jest.mock("@/components/context-workbench/panels/team-members-panel", () => ({
  TeamMembersPanel: ({ teamId }: { teamId?: string | null }) => (
    <div data-testid="team-members-panel" data-team-id={teamId ?? ""} />
  ),
}))
jest.mock("@/components/performance/perf-capture-shell-status", () => ({
  PerfCaptureShellStatus: () => null,
}))

// App-bar width tiers. The default (nothing matches) is the narrow phone bar,
// which is the shape every existing test in this file was written against.
const mediaMatches: Record<string, boolean> = {}
jest.mock("@/hooks/ui/use-media-query", () => ({
  useMediaQuery: (query: string) => mediaMatches[query] ?? false,
}))
const APPBAR_INBOX_QUERY = "(min-width: 26rem)"
const APPBAR_ARTIFACTS_QUERY = "(min-width: 30rem)"

// Header children that reach Dexie / native polling on mount. Stubbed so the
// bar's own layout contract is what these tests measure.
jest.mock("@/components/mobile/shell/mobile-workspace-chip", () => ({
  MobileWorkspaceChip: ({ className }: { className?: string }) => (
    <span data-testid="mobile-workspace-chip-stub" className={className} />
  ),
}))
jest.mock("@/components/chat/background-runs-chip", () => ({
  BackgroundRunsChip: ({ className }: { className?: string }) => (
    <span data-testid="background-runs-chip-stub" className={className} />
  ),
}))
jest.mock("@/components/desktop/job-center-panel", () => ({
  JobCenterPanel: () => <button type="button" data-testid="status-job-center" />,
}))
jest.mock("@/components/mobile/home/mobile-home-layout-sheet", () => ({
  MobileHomeLayoutSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mobile-quick-actions-editor-sheet" /> : null,
}))
// The real grid reads the settings store through a different module path than
// this suite mocks, and the ChatPane stub never renders the welcome slots
// anyway. The seam under test is the ELEMENT the shell builds, so the stub only
// has to keep the real component out of the graph.
jest.mock("@/components/mobile/home/mobile-quick-actions", () => ({
  MobileQuickActions: () => <div data-testid="mobile-quick-actions-stub" />,
}))
// The search palette is its own surface with its own suite; here it only has
// to be a sheet that can be open.
jest.mock("@/components/mobile/home/mobile-command-palette", () => ({
  MobileCommandPalette: ({ open }: { open: boolean }) =>
    open ? <div data-testid="command-palette-stub" /> : null,
}))
jest.mock("@/components/mobile/home/mobile-active-runs-card", () => ({
  MobileActiveRunsCard: () => null,
}))

const toggleArtifactDock = jest.fn()
let artifactDockState = {
  dockCollapsed: true,
  unreadArtifact: false,
  toggleDock: toggleArtifactDock,
}
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: (selector: (s: unknown) => unknown) => selector(artifactDockState),
}))

import { AppShellMobile } from "./app-shell-mobile"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  select.mockReset()
  create.mockReset()
  remove.mockReset().mockResolvedValue(undefined)
  rename.mockReset()
  directSend.mockReset().mockResolvedValue(undefined)
  teamSend.mockReset().mockResolvedValue(undefined)
  setPermissionMode.mockReset()
  updateSession.mockReset().mockResolvedValue(undefined)
  hapterImpact.mockReset()
  hapterNotify.mockReset()
  setSelectedGuild.mockReset().mockImplementation((g: SelectedGuild) => {
    selectedGuild = g
  })
  clearPendingSettings.mockReset()
  loadSettings.mockClear()
  routerPush.mockReset()
  toastError.mockReset()
  sessionsRef.current = []
  activeSessionId = null
  selectedGuild = { kind: "dm" }
  errorMessageRef.current = null
  pendingSettingsRequestRef.current = null
  credentialStatusRef.current = { keyOk: true, plan: null }
  for (const key of Object.keys(mediaMatches)) delete mediaMatches[key]
  toggleArtifactDock.mockReset()
  artifactDockState = { dockCollapsed: true, unreadArtifact: false, toggleDock: toggleArtifactDock }
  inboxUnreadRef.current = 0
  welcomeExtrasRef.current = null
  isLoadingSessionsRef.current = false
  requestChatHome.mockReset()
  clearActiveSession.mockReset()
  channelListPropsRef.current = null
  sourceCharactersRef.current = undefined
  useDexieFirstQuery.mockClear()
  runtimeGateRef.current = {
    composerDisabled: false,
    availability: { state: "available", reason: "local-host" },
    recovery: { kind: "none" },
    connecting: false,
  }
})

/** The `welcomeExtras` bundle the shell handed the chat pane on this render. */
function lastWelcomeExtras(): NonNullable<typeof welcomeExtrasRef.current> {
  const extras = welcomeExtrasRef.current
  if (!extras) throw new Error("ChatPane rendered without welcomeExtras")
  return extras
}

describe("<AppShellMobile />", () => {
  it("renders top bar, hamburger, and chat pane", () => {
    render(<AppShellMobile />)
    expect(screen.getByTestId("app-shell-mobile")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-nav-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("chat-pane")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-actions-trigger")).toBeInTheDocument()
  })

  it("wraps the chat pane in the artifact workspace dock (gap11)", () => {
    render(<AppShellMobile />)
    const dock = screen.getByTestId("artifact-workspace-dock")
    expect(dock).toBeInTheDocument()
    // the dock must CONTAIN the chat pane (so an artifact has a panel to open)
    expect(dock).toContainElement(screen.getByTestId("chat-pane"))
  })

  it("applies left/right safe-area insets so a landscape notch never covers content", () => {
    render(<AppShellMobile />)
    // safe-area-px = env(safe-area-inset-left/right); pairs with safe-area-pt
    // on the shell root so notches are cleared on all edges incl. landscape.
    expect(screen.getByTestId("app-shell-mobile")).toHaveClass("safe-area-px")
  })

  /**
   * The tab-bar reserve is made EXACTLY once, by `MobileShellWrapper`.
   *
   * This shell used to be `h-[100dvh]` and re-assert the same
   * `pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]` on its <main>,
   * on the grounds that a viewport-tall root escapes the wrapper's padding. It
   * did, and the two reserves then stacked: the wrapper's box came out 56px +
   * inset TALLER than the screen, hidden on `/` by
   * `body[data-app-shell]{overflow:hidden}` and surfacing as a bare strip under
   * every other route the moment that attribute was cleared. `/` is a
   * full-viewport route now, so the wrapper's definite-height column has
   * already subtracted the bar and this shell just fills it.
   */
  it("makes the tab-bar reserve exactly once, in the wrapper, not again here", () => {
    const { container } = render(<AppShellMobile />)
    const root = screen.getByTestId("app-shell-mobile")
    expect(root.className).toContain("h-full")
    expect(root.className).not.toContain("h-[100dvh]")
    // The wrapper puts the offline banner and the first-run setup bar in the
    // same column above this shell. Height alone would claim the whole column
    // and overflow it by however tall those rows are on the day they appear.
    expect(root.className).toContain("flex-1")
    expect(root.className).toContain("min-h-0")
    const main = container.querySelector("main")
    expect(main?.className).not.toContain("env(safe-area-inset-bottom)")
  })

  /**
   * The bar packs 303px of fixed chrome at 375px before the session title gets
   * a pixel, so anything past that has to earn its place by width. Measured at
   * 403px in a 375px shell, the ⋮ menu (the only route to new chat / settings /
   * export / delete) sat off-screen and the document gained a horizontal
   * scroll that dragged every fixed layer, the tab bar included, with it.
   */
  it("clips the app bar and pins its action group so nothing can be pushed off-screen", () => {
    render(<AppShellMobile />)
    const header = document.querySelector("[data-app-chrome]") as HTMLElement
    expect(header.className).toContain("overflow-hidden")
    const actions = screen.getByTestId("mobile-actions-trigger").parentElement as HTMLElement
    expect(actions.className).toContain("shrink-0")
    // The things that grow must be the things that give up width.
    expect(screen.getByTestId("mobile-workspace-chip-stub").className).toContain("shrink")
  })

  it("folds inbox and artifacts into the overflow menu on a narrow bar", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)
    expect(screen.queryByTestId("mobile-inbox-trigger")).toBeNull()
    expect(screen.queryByTestId("chat-artifact-dock-toggle")).toBeNull()

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-action-inbox")).toBeInTheDocument())
    expect(screen.getByTestId("mobile-action-artifacts")).toBeInTheDocument()
  })

  it("puts them back in the bar once it is wide enough, and never in both places", async () => {
    mediaMatches[APPBAR_INBOX_QUERY] = true
    mediaMatches[APPBAR_ARTIFACTS_QUERY] = true
    const user = userEvent.setup()
    render(<AppShellMobile />)
    expect(screen.getByTestId("mobile-inbox-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("chat-artifact-dock-toggle")).toBeInTheDocument()

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-action-new-chat")).toBeInTheDocument())
    expect(screen.queryByTestId("mobile-action-inbox")).toBeNull()
    expect(screen.queryByTestId("mobile-action-artifacts")).toBeNull()
  })

  // Folding a control must move its attention signal, not delete it.
  it("carries a folded control's unread onto the overflow trigger", () => {
    artifactDockState = { ...artifactDockState, unreadArtifact: true }
    render(<AppShellMobile />)
    expect(screen.getByTestId("mobile-actions-unread-dot")).toBeInTheDocument()
  })

  it("carries a folded inbox's unread onto the overflow trigger too", () => {
    inboxUnreadRef.current = 3
    render(<AppShellMobile />)
    expect(screen.getByTestId("mobile-actions-unread-dot")).toBeInTheDocument()
  })

  it("puts the dot on the menu row itself, not only on the trigger", async () => {
    inboxUnreadRef.current = 3
    artifactDockState = { ...artifactDockState, unreadArtifact: true }
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-actions-trigger"))
    expect(await screen.findByTestId("mobile-action-inbox-unread-dot")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-action-artifacts-unread-dot")).toBeInTheDocument()
  })

  it("drops the folded dot once the control is back in the bar", () => {
    mediaMatches[APPBAR_ARTIFACTS_QUERY] = true
    mediaMatches[APPBAR_INBOX_QUERY] = true
    artifactDockState = { ...artifactDockState, unreadArtifact: true }
    inboxUnreadRef.current = 3
    render(<AppShellMobile />)
    expect(screen.queryByTestId("mobile-actions-unread-dot")).toBeNull()
  })

  // An open dock is not an unread one: the artifact store raises the flag when
  // something arrives while the panel is dismissed, and the in-bar toggle reads
  // it the same way.
  it("suppresses the artifact dot while the dock is already open", () => {
    artifactDockState = { ...artifactDockState, unreadArtifact: true, dockCollapsed: false }
    render(<AppShellMobile />)
    expect(screen.queryByTestId("mobile-actions-unread-dot")).toBeNull()
  })

  // The other door to the same sheet: the grid's "Edit" asks the shell, which
  // owns the state. That seam is the whole reason the sheet moved up here.
  it("opens the home-layout editor from the quick-action grid's Edit", () => {
    render(<AppShellMobile />)
    const extras = lastWelcomeExtras()
    expect(extras.hideNewChatAction).toBe(true)
    const grid = extras.quickActions as React.ReactElement<{ onEditLayout: () => void }>
    expect(screen.queryByTestId("mobile-quick-actions-editor-sheet")).toBeNull()
    act(() => {
      grid.props.onEditLayout()
    })
    expect(screen.getByTestId("mobile-quick-actions-editor-sheet")).toBeInTheDocument()
  })

  // The grid that hosts the other "Edit" entry renders null once its section is
  // hidden, so this is the editor's only unconditional door.
  it("opens the home-layout editor from the overflow menu", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await user.click(await screen.findByTestId("mobile-action-home-layout"))
    await waitFor(() =>
      expect(screen.getByTestId("mobile-quick-actions-editor-sheet")).toBeInTheDocument()
    )
  })

  it("opens the navigation drawer when hamburger is pressed", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-nav-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-nav-sheet")).toBeInTheDocument())
    expect(screen.getByTestId("guild-create-team")).toBeInTheDocument()
  })

  it("keeps an explicit close control for assistive tech, off the list's +", async () => {
    // The painted corner button sat on top of New chat's "+", so it is gone —
    // but a screen reader cannot always reach the overlay, Escape or a swipe.
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-nav-trigger"))
    const close = await screen.findByTestId("mobile-nav-close")
    expect(close).toHaveAccessibleName("closeNav")
    expect(close).toHaveClass("sr-only")
    await user.click(close)
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-sheet")).toBeNull())
  })

  it("opens and closes the drawer on an edge swipe, the way every phone drawer does", async () => {
    render(<AppShellMobile />)
    const touch = (x: number, y: number) =>
      Object.assign([{ clientX: x, clientY: y } as Touch], {
        item: () => ({ clientX: x, clientY: y }) as Touch,
      }) as unknown as TouchList
    const fire = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true }) as TouchEvent
      Object.defineProperty(event, "touches", { value: touch(x, y) })
      Object.defineProperty(event, "changedTouches", { value: touch(x, y) })
      act(() => {
        window.dispatchEvent(event)
      })
    }
    const swipe = (fromX: number, toX: number) => {
      fire("touchstart", fromX, 400)
      fire("touchmove", toX, 400)
      fire("touchend", toX, 400)
    }

    swipe(6, 180)
    await waitFor(() => expect(screen.getByTestId("mobile-nav-sheet")).toBeInTheDocument())

    // And back out the way it came.
    swipe(200, 40)
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-sheet")).toBeNull())
  })

  it("stands down while another sheet owns the screen", async () => {
    // A drag aimed at the surface in front cannot be told apart from one aimed
    // at the shell behind it, and answering both stacks the drawer under a
    // sheet the user is still reading.
    //
    // Opened through the search palette. This used to open the character
    // picker through ⋮ → New chat, which stopped opening it when every New
    // chat door moved to the welcome surface; the test had been waiting on a
    // picker that never came.
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-search-trigger"))
    await waitFor(() => expect(screen.getByTestId("command-palette-stub")).toBeInTheDocument())

    const touch = (x: number, y: number) =>
      Object.assign([{ clientX: x, clientY: y } as Touch], {
        item: () => ({ clientX: x, clientY: y }) as Touch,
      }) as unknown as TouchList
    const fire = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true }) as TouchEvent
      Object.defineProperty(event, "touches", { value: touch(x, y) })
      Object.defineProperty(event, "changedTouches", { value: touch(x, y) })
      act(() => {
        window.dispatchEvent(event)
      })
    }
    fire("touchstart", 6, 400)
    fire("touchmove", 180, 400)
    fire("touchend", 180, 400)
    expect(screen.queryByTestId("mobile-nav-sheet")).toBeNull()
  })

  describe("drawer gestures", () => {
    const touch = (x: number, y: number) =>
      Object.assign([{ clientX: x, clientY: y } as Touch], {
        item: () => ({ clientX: x, clientY: y }) as Touch,
      }) as unknown as TouchList
    const fire = (target: EventTarget, type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true }) as TouchEvent
      // A lifted finger is no longer in `touches`, only in `changedTouches`.
      const lifted = Object.assign([], { item: () => null }) as unknown as TouchList
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? lifted : touch(x, y),
      })
      Object.defineProperty(event, "changedTouches", { value: touch(x, y) })
      act(() => {
        target.dispatchEvent(event)
      })
    }
    const swipeLeftFrom = (target: EventTarget) => {
      fire(target, "touchstart", 200, 400)
      fire(target, "touchmove", 60, 404)
      fire(target, "touchend", 60, 404)
    }
    const openDrawer = async () => {
      const user = userEvent.setup()
      await user.click(screen.getByTestId("mobile-nav-trigger"))
      await waitFor(() => expect(screen.getByTestId("mobile-nav-sheet")).toBeInTheDocument())
    }

    it("leaves a drag that starts on a conversation row to the row", async () => {
      // The row reveals its actions at ~108px; the drawer closes at 56px. This
      // used to shut the drawer under the finger reaching for Delete.
      render(<AppShellMobile />)
      await openDrawer()
      swipeLeftFrom(screen.getByTestId("channel-row-stub"))
      expect(screen.getByTestId("mobile-nav-sheet")).toBeInTheDocument()
    })

    it("still closes on a drag that starts on the drawer itself", async () => {
      render(<AppShellMobile />)
      await openDrawer()
      swipeLeftFrom(screen.getByTestId("channel-body-stub"))
      await waitFor(() => expect(screen.queryByTestId("mobile-nav-sheet")).toBeNull())
    })

    it("ignores a drag on a surface opened from inside the drawer", async () => {
      // An action sheet or confirm is portaled outside the drawer; a sideways
      // flick there is not a request to put the drawer away underneath it.
      render(<AppShellMobile />)
      await openDrawer()
      const portaled = document.createElement("div")
      document.body.appendChild(portaled)
      swipeLeftFrom(portaled)
      expect(screen.getByTestId("mobile-nav-sheet")).toBeInTheDocument()
      portaled.remove()
    })
  })

  describe("navigation drawer", () => {
    it("has no corner close button covering the list's New chat", async () => {
      const user = userEvent.setup()
      render(<AppShellMobile />)
      await user.click(screen.getByTestId("mobile-nav-trigger"))
      const sheet = await screen.findByTestId("mobile-nav-sheet")
      expect(within(sheet).queryByRole("button", { name: "Close" })).toBeNull()
    })

    it("reserves the notch, home indicator and landscape inset itself", async () => {
      // Portaled out of the shell, so the shell's own safe-area classes never
      // reached it.
      const user = userEvent.setup()
      render(<AppShellMobile />)
      await user.click(screen.getByTestId("mobile-nav-trigger"))
      const sheet = await screen.findByTestId("mobile-nav-sheet")
      expect(sheet).toHaveClass(
        "pt-[env(safe-area-inset-top)]",
        "pb-[env(safe-area-inset-bottom)]",
        "pl-[env(safe-area-inset-left)]"
      )
    })

    it("lets the list column shrink to its slot", async () => {
      const user = userEvent.setup()
      render(<AppShellMobile />)
      await user.click(screen.getByTestId("mobile-nav-trigger"))
      expect(await screen.findByTestId("mobile-nav-list-slot")).toHaveClass("min-w-0", "flex-1")
    })

    it("hands the list the shared writers and the loading state, un-voided", async () => {
      isLoadingSessionsRef.current = true
      const user = userEvent.setup()
      render(<AppShellMobile />)
      await user.click(screen.getByTestId("mobile-nav-trigger"))
      await screen.findByTestId("mobile-nav-sheet")
      const props = channelListPropsRef.current!
      expect(props.isLoadingSessions).toBe(true)
      // Passed through as-is so the list can await them and surface failures.
      expect(props.onDelete).toBe(remove)
      expect(props.onRename).toBe(rename)
      expect(props.onArchive).toBe(archive)
      expect(props.onUnarchive).toBe(unarchive)
      expect(props.onSetPinned).toBe(bulkSetPinned)
      expect(props.onAssignToFolder).toBe(assignToFolder)
    })

    it("keeps the list's source outside the drawer, fed by the shell's character read", () => {
      render(<AppShellMobile />)
      // Mounted while the drawer is closed — that is what survives a reopen.
      expect(screen.getByTestId("channel-list-source")).toBeInTheDocument()
      expect(screen.queryByTestId("mobile-nav-sheet")).toBeNull()
      expect(sourceCharactersRef.current).toBe(shellCharacters)
      expect(useDexieFirstQuery).toHaveBeenCalledWith(
        expect.objectContaining({ table: "characters" })
      )
    })
  })

  it("mounts the guild rail in its sheet variant so it is not md-gated away", async () => {
    // The rail's default variant is `hidden md:flex`. A phone viewport never
    // reaches `md`, so the default would render the drawer's entire navigation
    // column — workspaces, DM/Canvas, pinned features, More, Settings — as
    // display:none, leaving only the session list.
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-nav-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-nav-sheet")).toBeInTheDocument())
    expect(screen.getByTestId("guild-rail")).toHaveAttribute("data-variant", "sheet")
  })

  it("closes the drawer and selects a session when a channel is picked", async () => {
    sessionsRef.current = [
      {
        id: "s-2",
        title: "team session",
        kind: "team",
        teamId: "t-1",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-nav-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-nav-sheet")).toBeInTheDocument())
    await user.click(screen.getByTestId("channel-select-stub"))
    await waitFor(() => expect(select).toHaveBeenCalledWith("s-2"))
    expect(setSelectedGuild).toHaveBeenCalled()
  })

  it("renders the active session title in the top bar", () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "Greetings",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"
    render(<AppShellMobile />)
    expect(screen.getByTestId("mobile-active-title")).toHaveTextContent("Greetings")
    expect(screen.getByTestId("shared-mobile-controls")).toHaveTextContent("s-1")
  })

  it("delegates plan continuation to the shared conversation surface", () => {
    sessionsRef.current = [
      { id: "s-1", title: "Direct", kind: "direct", createdAt: 0, updatedAt: 0 } as ChatSession,
    ]
    activeSessionId = "s-1"
    render(<AppShellMobile />)
    expect(screen.getByTestId("chat-pane")).toHaveAttribute("data-has-plan-resume", "false")
    expect(directSend).not.toHaveBeenCalled()
  })

  it("does not wire plan approval for team sessions (plan mode is direct-only)", () => {
    sessionsRef.current = [
      {
        id: "s-2",
        title: "Team",
        kind: "team",
        teamId: "t-1",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-2"
    render(<AppShellMobile />)
    expect(screen.getByTestId("chat-pane")).toHaveAttribute("data-has-plan-resume", "false")
  })

  it("opens the members sheet when the members button is pressed (team session only)", async () => {
    sessionsRef.current = [
      {
        id: "s-2",
        title: "Team session",
        kind: "team",
        teamId: "t-1",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-2"
    const user = userEvent.setup()
    render(<AppShellMobile />)

    expect(screen.getByTestId("mobile-members-trigger")).toBeInTheDocument()
    await user.click(screen.getByTestId("mobile-members-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-members-sheet")).toBeInTheDocument())
    // The same workbench panel the desktop shows, bound to this session's team.
    expect(screen.getByTestId("team-members-panel")).toBeInTheDocument()
    expect(screen.getByTestId("team-members-panel")).toHaveAttribute("data-team-id", "t-1")
  })

  it("does not render the members trigger for direct (non-team) sessions", () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "Direct chat",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"
    render(<AppShellMobile />)
    expect(screen.queryByTestId("mobile-members-trigger")).not.toBeInTheDocument()
  })

  it("lands ⋮ → 'New chat' on the welcome surface, not the character picker", async () => {
    // Every New chat door on this shell goes to the welcome screen (the picker
    // is reachable from the welcome's own entry). The old assertion here
    // expected the picker, which that change stopped opening.
    const user = userEvent.setup()
    render(<AppShellMobile />)

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-action-new-chat")).toBeInTheDocument())
    await user.click(screen.getByTestId("mobile-action-new-chat"))

    await waitFor(() => expect(requestChatHome).toHaveBeenCalled())
    expect(clearActiveSession).toHaveBeenCalled()
    expect(screen.queryByTestId("char-picker")).toBeNull()
  })

  it("routes to /settings via the actions menu → 'Settings'", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-action-settings")).toBeInTheDocument())
    await user.click(screen.getByTestId("mobile-action-settings"))

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings"))
  })

  it("routes to /inbox/all via the top-bar inbox button", async () => {
    // Wide enough for the bar to hold the inbox control itself; the narrow
    // shape reaches the same route through the overflow entry below.
    mediaMatches[APPBAR_INBOX_QUERY] = true
    const user = userEvent.setup()
    render(<AppShellMobile />)

    await user.click(screen.getByTestId("mobile-inbox-trigger"))
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/inbox/all"))
  })

  it("routes to /inbox/all from the overflow entry when the bar folded it", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await user.click(await screen.findByTestId("mobile-action-inbox"))
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/inbox/all"))
  })

  it("toggles the artifact dock from the overflow entry when the bar folded it", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await user.click(await screen.findByTestId("mobile-action-artifacts"))
    expect(toggleArtifactDock).toHaveBeenCalled()
  })

  it("delete action invokes remove(activeSessionId) and toasts on failure", async () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "x",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"
    remove.mockReset().mockRejectedValueOnce(new Error("nope"))

    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await user.click(await screen.findByTestId("mobile-action-delete"))

    await waitFor(() => expect(remove).toHaveBeenCalledWith("s-1"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("nope"))
  })

  it("export action opens the conversation export dialog for the active session", async () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "x",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"

    const user = userEvent.setup()
    render(<AppShellMobile />)
    expect(screen.queryByTestId("single-export-dialog")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await user.click(await screen.findByTestId("mobile-action-export"))

    const dialog = await screen.findByTestId("single-export-dialog")
    expect(dialog).toHaveTextContent("s-1")
  })

  it("suppresses the inner ChatHeader (showHeader=false) to avoid a duplicate mobile header", () => {
    render(<AppShellMobile />)
    expect(screen.getByTestId("chat-pane")).toHaveAttribute("data-show-header", "false")
  })

  it("opens the per-session settings sheet (with ambient status) via the actions menu", async () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "x",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"

    const user = userEvent.setup()
    render(<AppShellMobile />)
    expect(screen.queryByTestId("session-settings-sheet")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await user.click(await screen.findByTestId("mobile-action-session-settings"))

    const sheet = await screen.findByTestId("session-settings-sheet")
    expect(sheet).toHaveTextContent("s-1")
    // Ambient cluster (cost / plan-tasks / plugin slot) is relocated here.
    expect(sheet).toHaveAttribute("data-ambient", "1")
  })

  it("shows the No-API-key warning and opens session settings when credentials are missing", async () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "x",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"
    credentialStatusRef.current = { keyOk: false, plan: null }

    const user = userEvent.setup()
    render(<AppShellMobile />)
    const warning = screen.getByTestId("mobile-no-api-key")
    expect(warning).toBeInTheDocument()

    await user.click(warning)
    await waitFor(() => expect(screen.getByTestId("session-settings-sheet")).toBeInTheDocument())
  })

  it("hides the No-API-key warning when credentials are present", () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "x",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"
    credentialStatusRef.current = { keyOk: true, plan: null }

    render(<AppShellMobile />)
    expect(screen.queryByTestId("mobile-no-api-key")).not.toBeInTheDocument()
  })

  it("shrinks the credential warning to an icon on a narrow bar and labels it when wide", () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "x",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"
    credentialStatusRef.current = { keyOk: false, plan: null }
    const { unmount } = render(<AppShellMobile />)
    expect(screen.getByTestId("mobile-no-api-key")).toHaveAttribute("data-show-label", "false")
    unmount()
    mediaMatches["(min-width: 36rem)"] = true
    render(<AppShellMobile />)
    expect(screen.getByTestId("mobile-no-api-key")).toHaveAttribute("data-show-label", "true")
  })

  it("gates the composer on chat availability, the way the desktop workspace does", () => {
    render(<AppShellMobile />)
    expect(screen.getByTestId("chat-pane")).toHaveAttribute("data-composer-disabled", "false")
    expect(screen.queryByTestId("mobile-chat-runtime-notice")).toBeNull()
  })

  it("disables the composer and explains why when the host cannot take a send", () => {
    runtimeGateRef.current = {
      composerDisabled: true,
      availability: { state: "requires-pairing", reason: "companion-not-paired" },
      recovery: { kind: "route" },
      connecting: false,
    }
    render(<AppShellMobile />)
    expect(screen.getByTestId("chat-pane")).toHaveAttribute("data-composer-disabled", "true")
    expect(screen.getByTestId("mobile-chat-runtime-notice")).toBeInTheDocument()
  })

  it("hides the export action when there is no active session", async () => {
    sessionsRef.current = []
    activeSessionId = null

    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-action-new-chat")).toBeInTheDocument())
    expect(screen.queryByTestId("mobile-action-export")).not.toBeInTheDocument()
  })

  it("opens guild settings via guild rail's settings button (and closes drawer)", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)

    await user.click(screen.getByTestId("mobile-nav-trigger"))
    await waitFor(() => expect(screen.getByTestId("guild-open-settings")).toBeInTheDocument())
    await act(async () => {
      screen.getByTestId("guild-open-settings").click()
    })
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings"))
  })

  it("fires a light haptic after a successful send", async () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "x",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("chat-send-stub"))
    await waitFor(() =>
      expect(directSend).toHaveBeenCalledWith("hi", undefined, {
        attachmentManifest: [{ filename: "report.txt", mediaType: "text/plain", kind: "document" }],
      })
    )
    await waitFor(() => expect(hapterImpact).toHaveBeenCalledWith("light"))
    expect(hapterNotify).not.toHaveBeenCalled()
  })

  it("uses the team send signature without dropping attachment provenance", async () => {
    sessionsRef.current = [
      {
        id: "team-session",
        title: "Team",
        kind: "team",
        teamId: "t-1",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "team-session"
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("chat-send-stub"))
    await waitFor(() =>
      expect(teamSend).toHaveBeenCalledWith("hi", {
        attachmentManifest: [{ filename: "report.txt", mediaType: "text/plain", kind: "document" }],
      })
    )
    expect(directSend).not.toHaveBeenCalled()
  })

  it("forwards pre-search sources on mobile before direct dispatch", async () => {
    sessionsRef.current = [
      {
        id: "s-web",
        title: "Web",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-web"
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("chat-send-web-stub"))
    await waitFor(() =>
      expect(directSend).toHaveBeenCalledWith("web", undefined, {
        attachmentManifest: undefined,
        templateRun: null,
        webSearchContext: {
          provider: "tavily",
          results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
        },
      })
    )
  })

  it("fires an error haptic when a send throws", async () => {
    sessionsRef.current = [
      {
        id: "s-1",
        title: "x",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    activeSessionId = "s-1"
    directSend.mockReset().mockRejectedValueOnce(new Error("boom"))
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("chat-send-stub"))
    await waitFor(() => expect(hapterNotify).toHaveBeenCalledWith("error"))
    expect(hapterImpact).not.toHaveBeenCalled()
  })

  it("auto-selects the most-recent matching session on first render", async () => {
    sessionsRef.current = [
      {
        id: "s-9",
        title: "older",
        kind: "direct",
        createdAt: 0,
        updatedAt: 0,
      } as unknown as ChatSession,
    ]
    render(<AppShellMobile />)
    await waitFor(() => expect(select).toHaveBeenCalledWith("s-9"))
  })
})

it("leaves platform read capture to the shared pane and retains local session reads", async () => {
  const { markSessionRead } = jest.requireMock("@/lib/db/session-state") as {
    markSessionRead: jest.Mock
  }
  activeSessionId = "im"
  sessionsRef.current = [
    {
      id: "im",
      title: "Platform",
      kind: "direct",
      createdAt: 0,
      updatedAt: 0,
      platformBinding: {
        platform: "slack",
        adapterId: "a",
        conversationKey: "slack:a:k",
        conversationRef: { platform: "slack", adapterId: "a" },
      },
    } as ChatSession,
  ]
  const view = render(<AppShellMobile />)
  await act(async () => {})
  expect(markSessionRead).not.toHaveBeenCalled()
  activeSessionId = "local"
  sessionsRef.current = [
    { id: "local", title: "Local", kind: "direct", createdAt: 0, updatedAt: 0 } as ChatSession,
  ]
  view.rerender(<AppShellMobile />)
  await waitFor(() => expect(markSessionRead).toHaveBeenCalledWith("local"))
})

it("lets the welcome composer address a runtime only when its first turn is a direct chat", () => {
  // With no session `handleFirstTurn` creates a direct chat, which takes a
  // runtime route; into an active team room it sends through the room's own
  // router, which carries none — so the hero must not offer one there.
  const { unmount } = render(<AppShellMobile />)
  expect(screen.getByTestId("chat-pane")).toHaveAttribute("data-hero-routing", "true")
  unmount()
  activeSessionId = "team-session"
  sessionsRef.current = [
    {
      id: "team-session",
      title: "Team",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as ChatSession,
  ]
  render(<AppShellMobile />)
  expect(screen.getByTestId("chat-pane")).toHaveAttribute("data-hero-routing", "false")
})

it("normalizes an explicitly absent template before the mobile team send", async () => {
  activeSessionId = "team-session"
  sessionsRef.current = [
    {
      id: "team-session",
      title: "Team",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as ChatSession,
  ]
  const user = userEvent.setup()
  render(<AppShellMobile />)
  await user.click(screen.getByTestId("chat-send-web-stub"))
  await waitFor(() =>
    expect(teamSend).toHaveBeenCalledWith(
      "web",
      expect.objectContaining({
        templateRun: undefined,
        webSearchContext: {
          provider: "tavily",
          results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
        },
      })
    )
  )
  expect(directSend).not.toHaveBeenCalled()
})
