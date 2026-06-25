/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatSession } from "@/lib/claude/types"
import type { SelectedGuild } from "@/stores/ui"

const logInfo = jest.fn()
const logWarn = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: { default?: string }) => opts?.default ?? key,
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}))

jest.mock("@/lib/logging", () => {
  const makeStub = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: () => makeStub(),
  })
  return {
    loggers: {
      shell: {
        info: (...args: unknown[]) => logInfo(...args),
        warn: (...args: unknown[]) => logWarn(...args),
        error: jest.fn(),
        child: () => makeStub(),
      },
      ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => makeStub() },
      // `agent` is reached transitively via the agent-team store import chain
      // (actions.slice.ts calls `loggers.agent.child("team-store")` at module
      // load); without it the whole suite fails to load.
      agent: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => makeStub() },
    },
    createLogger: () => makeStub(),
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
let activeSessionId: string | null = null
jest.mock("@/hooks/chat", () => ({
  useSessions: () => ({
    sessions: sessionsRef.current,
    activeSessionId,
    select,
    create,
    remove,
    rename,
  }),
  useClaudeChat: () => ({
    send: jest.fn(),
    stop: jest.fn(),
    regenerate: jest.fn(),
    editAndResend: jest.fn(),
    respondToApproval: jest.fn(),
  }),
  useTeamChat: () => ({
    send: jest.fn(),
    stop: jest.fn(),
    regenerate: jest.fn(),
    editAndResend: jest.fn(),
    respondToApproval: jest.fn(),
  }),
}))

const errorMessageRef: { current: string | null } = { current: null }
jest.mock("@/stores/chat", () => ({
  useChatStore: <T,>(
    selector: (s: { errorMessage: string | null; status: string; pendingApprovals: unknown[] }) => T
  ): T =>
    selector({
      errorMessage: errorMessageRef.current,
      status: "idle",
      pendingApprovals: [],
    }),
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
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(
    selector: (s: {
      selectedGuild: SelectedGuild
      setSelectedGuild: typeof setSelectedGuild
      pendingSettingsRequest: typeof pendingSettingsRequestRef.current
      clearPendingSettings: typeof clearPendingSettings
    }) => T
  ): T =>
    selector({
      selectedGuild,
      setSelectedGuild,
      pendingSettingsRequest: pendingSettingsRequestRef.current,
      clearPendingSettings,
    }),
}))

jest.mock("@/lib/db/schema", () => ({
  whenSeeded: jest.fn().mockResolvedValue(undefined),
  getDb: () => ({
    inboundLedger: { where: () => ({ above: () => ({ count: async () => 0 }) }) },
  }),
}))

jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/db/characters", () => ({
  listCharacters: () => Promise.resolve([]),
}))

jest.mock("@/lib/db/teams", () => ({
  getTeam: () => Promise.resolve(undefined),
}))

jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(_query: () => Promise<T>, _deps: unknown, fallback: T): T => fallback,
}))

// Stub heavy children — the shell test verifies structural wiring, not
// child internals.
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: ({ showHeader }: { showHeader?: boolean }) => (
    <div data-testid="chat-pane" data-show-header={showHeader === false ? "false" : "true"} />
  ),
}))
jest.mock("@/components/chat/character-picker", () => ({
  CharacterPicker: ({ open }: { open: boolean }) =>
    open ? <div data-testid="char-picker" /> : null,
}))
jest.mock("@/components/shell/onboarding-dialog", () => ({
  OnboardingDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="onboarding" /> : null,
}))
jest.mock("@/components/chat/tool-approval-dialog", () => ({
  ToolApprovalDialog: () => null,
}))
jest.mock("@/components/shell/guild-rail", () => ({
  GuildRail: ({
    onCreateTeam,
    onOpenSettings,
  }: {
    onCreateTeam: () => void
    onOpenSettings: () => void
  }) => (
    <div>
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

jest.mock("@/components/mobile/shell/mobile-channel-list", () => ({
  MobileChannelList: ({
    onSelect,
    onNewDirect,
  }: {
    onSelect: (id: string) => void
    onNewDirect: () => void
  }) => (
    <div>
      <button data-testid="channel-select-stub" onClick={() => onSelect("s-2")} />
      <button data-testid="channel-new-direct-stub" onClick={onNewDirect} />
    </div>
  ),
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
jest.mock("@/components/shell/member-list", () => ({
  MemberList: () => <div data-testid="member-list" />,
}))

import { AppShellMobile } from "./app-shell-mobile"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  select.mockReset()
  create.mockReset()
  remove.mockReset().mockResolvedValue(undefined)
  rename.mockReset()
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
})

describe("<AppShellMobile />", () => {
  it("renders top bar, hamburger, and chat pane", () => {
    render(<AppShellMobile />)
    expect(screen.getByTestId("app-shell-mobile")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-nav-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("chat-pane")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-actions-trigger")).toBeInTheDocument()
  })

  it("applies left/right safe-area insets so a landscape notch never covers content", () => {
    render(<AppShellMobile />)
    // safe-area-px = env(safe-area-inset-left/right); pairs with safe-area-pt
    // on the shell root so notches are cleared on all edges incl. landscape.
    expect(screen.getByTestId("app-shell-mobile")).toHaveClass("safe-area-px")
  })

  it("opens the navigation drawer when hamburger is pressed", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)
    await user.click(screen.getByTestId("mobile-nav-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-nav-sheet")).toBeInTheDocument())
    expect(screen.getByTestId("guild-create-team")).toBeInTheDocument()
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
    expect(screen.getByTestId("member-list")).toBeInTheDocument()
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

  it("opens the character picker via the actions menu → 'New chat'", async () => {
    const user = userEvent.setup()
    render(<AppShellMobile />)

    await user.click(screen.getByTestId("mobile-actions-trigger"))
    await waitFor(() => expect(screen.getByTestId("mobile-action-new-chat")).toBeInTheDocument())
    await user.click(screen.getByTestId("mobile-action-new-chat"))

    await waitFor(() => expect(screen.getByTestId("char-picker")).toBeInTheDocument())
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
    const user = userEvent.setup()
    render(<AppShellMobile />)

    await user.click(screen.getByTestId("mobile-inbox-trigger"))
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/inbox/all"))
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
