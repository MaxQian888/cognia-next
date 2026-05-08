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

jest.mock("@/lib/logger", () => ({
  loggers: {
    shell: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
    },
    ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  },
}))

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
    selector: (s: { errorMessage: string | null; pendingApprovals: unknown[] }) => T
  ): T => selector({ errorMessage: errorMessageRef.current, pendingApprovals: [] }),
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
}))

jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn().mockResolvedValue(undefined),
}))

// Stub heavy children — the shell test verifies structural wiring, not
// child internals.
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}))
jest.mock("@/components/chat/character-picker", () => ({
  CharacterPicker: ({ open }: { open: boolean }) =>
    open ? <div data-testid="char-picker" /> : null,
}))
jest.mock("@/components/desktop/onboarding-dialog", () => ({
  OnboardingDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="onboarding" /> : null,
}))
jest.mock("@/components/chat/tool-approval-dialog", () => ({
  ToolApprovalDialog: () => null,
}))
jest.mock("@/components/desktop/guild-rail", () => ({
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
jest.mock("@/components/desktop/channel-list", () => ({
  ChannelList: ({
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
jest.mock("@/components/desktop/member-list", () => ({
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
})

describe("<AppShellMobile />", () => {
  it("renders top bar, hamburger, and chat pane", () => {
    render(<AppShellMobile />)
    expect(screen.getByTestId("app-shell-mobile")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-nav-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("chat-pane")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-actions-trigger")).toBeInTheDocument()
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
