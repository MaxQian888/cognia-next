/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act } from "@testing-library/react"
import type { ChatSession } from "@/lib/claude/types"
import type { SelectedGuild } from "@/stores/ui"

const logInfo = jest.fn()
const logWarn = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), info: jest.fn(), success: jest.fn(), warning: jest.fn() },
}))

const sessionsRef: { current: ChatSession[] } = { current: [] }
const select = jest.fn()
const create = jest.fn()
const remove = jest.fn()
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

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

jest.mock("@/lib/db/schema", () => ({
  whenSeeded: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn().mockResolvedValue(undefined),
}))

// Stub heavy children — we only verify shell wiring, not their internals.
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}))
jest.mock("@/components/chat/character-picker", () => ({
  CharacterPicker: ({ open }: { open: boolean }) =>
    open ? <div data-testid="char-picker" /> : null,
}))
jest.mock("@/components/desktop/command-palette", () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
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
  ChannelList: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button data-testid="channel-select-stub" onClick={() => onSelect("s-2")} />
  ),
}))
jest.mock("@/components/desktop/member-list", () => ({
  MemberList: () => <div data-testid="member-list" />,
}))
jest.mock("@/components/artifacts/artifact-panel", () => ({
  ArtifactPanel: () => <div data-testid="artifact-panel" />,
}))
jest.mock("@/components/canvas", () => ({
  CanvasDocumentRail: () => null,
  CanvasWorkspace: () => null,
  CanvasSidePanels: () => null,
}))
jest.mock("@/components/desktop/onboarding-dialog", () => ({
  OnboardingDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="onboarding" /> : null,
}))
jest.mock("@/components/desktop/title-bar", () => ({
  TitleBar: () => <div data-testid="title-bar" />,
}))
jest.mock("@/components/chat/settings-dialog", () => ({
  SettingsDialog: ({ open, defaultTab }: { open: boolean; defaultTab: string }) =>
    open ? <div data-testid={`settings-${defaultTab}`} /> : null,
}))
jest.mock("@/components/chat/tool-approval-dialog", () => ({
  ToolApprovalDialog: () => null,
}))

import { DiscordShell } from "./shell"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  select.mockReset()
  create.mockReset()
  remove.mockReset()
  rename.mockReset()
  setSelectedGuild.mockReset().mockImplementation((g: SelectedGuild) => {
    selectedGuild = g
  })
  clearPendingSettings.mockReset()
  loadSettings.mockClear()
  sessionsRef.current = []
  activeSessionId = null
  selectedGuild = { kind: "dm" }
  errorMessageRef.current = null
  pendingSettingsRequestRef.current = null
})

test("renders title bar, guild rail, channel list, and command palette", () => {
  render(<DiscordShell />)
  expect(screen.getByTestId("title-bar")).toBeInTheDocument()
  expect(screen.getByTestId("guild-create-team")).toBeInTheDocument()
})

test("clicking the rail's Create-team button opens Settings → Teams (no toast)", async () => {
  render(<DiscordShell />)
  await act(async () => {
    screen.getByTestId("guild-create-team").click()
  })
  await waitFor(() => expect(screen.getByTestId("settings-teams")).toBeInTheDocument())
  expect(logInfo).toHaveBeenCalledWith("create-team click → settings")
})

test("clicking guild settings button opens Settings dialog with general tab", async () => {
  render(<DiscordShell />)
  await act(async () => {
    screen.getByTestId("guild-open-settings").click()
  })
  await waitFor(() => expect(screen.getByTestId("settings-general")).toBeInTheDocument())
})

test("auto-selects a matching session on first render and logs", async () => {
  sessionsRef.current = [
    { id: "s-1", title: "x", kind: "direct", createdAt: 0, updatedAt: 0 } as unknown as ChatSession,
  ]
  render(<DiscordShell />)
  await waitFor(() =>
    expect(logInfo).toHaveBeenCalledWith(
      "auto-select session",
      expect.objectContaining({ sessionId: "s-1" })
    )
  )
  expect(select).toHaveBeenCalledWith("s-1")
})

test("switching to a team session adjusts the guild filter via guildFromSession", async () => {
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
  // The ChannelList stub fires onSelect with "s-2" when clicked.
  render(<DiscordShell />)
  await act(async () => {
    screen.getByTestId("channel-select-stub").click()
  })
  await waitFor(() =>
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
  )
  expect(logInfo).toHaveBeenCalledWith(
    "switch-to-session",
    expect.objectContaining({ sessionId: "s-2" })
  )
})

test("opens settings via deep-link when pendingSettingsRequest is set", async () => {
  pendingSettingsRequestRef.current = { tab: "skills", nonce: 1 }
  render(<DiscordShell />)
  await waitFor(() => expect(screen.getByTestId("settings-skills")).toBeInTheDocument())
  expect(clearPendingSettings).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith(
    "open settings via deep-link",
    expect.objectContaining({ tab: "skills" })
  )
})
