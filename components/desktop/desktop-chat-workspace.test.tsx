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

const routerPush = jest.fn()
const routerReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, back: jest.fn() }),
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

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), info: jest.fn(), success: jest.fn(), warning: jest.fn() },
}))

const sessionsRef: { current: ChatSession[] } = { current: [] }
const select = jest.fn()
const create = jest.fn()
const remove = jest.fn()
const rename = jest.fn()
const bulkRemove = jest.fn().mockResolvedValue(undefined)
const bulkSetPinned = jest.fn().mockResolvedValue(undefined)
let activeSessionId: string | null = null
jest.mock("@/hooks/chat", () => ({
  useSessions: () => ({
    sessions: sessionsRef.current,
    activeSessionId,
    select,
    create,
    remove,
    rename,
    bulkRemove,
    bulkSetPinned,
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
      sidebarCollapsed: boolean
    }) => T
  ): T =>
    selector({
      selectedGuild,
      setSelectedGuild,
      pendingSettingsRequest: pendingSettingsRequestRef.current,
      clearPendingSettings,
      sidebarCollapsed: false,
    }),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn().mockResolvedValue(undefined),
}))

// Stub heavy children — we only verify workspace wiring, not their internals.
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}))
jest.mock("@/components/chat/character-picker", () => ({
  CharacterPicker: ({ open }: { open: boolean }) =>
    open ? <div data-testid="char-picker" /> : null,
}))
const channelListPropsLog: Array<Record<string, unknown>> = []
jest.mock("@/components/desktop/channel-list", () => ({
  ChannelList: (props: Record<string, unknown>) => {
    channelListPropsLog.push(props)
    const onSelect = props.onSelect as (id: string) => void
    return <button data-testid="channel-select-stub" onClick={() => onSelect("s-2")} />
  },
}))
jest.mock("@/components/shell/member-list", () => ({
  MemberList: () => <div data-testid="member-list" />,
}))
jest.mock("@/components/artifacts/artifact-panel", () => ({
  ArtifactPanel: () => <div data-testid="artifact-panel" />,
}))
jest.mock("@/components/canvas", () => ({
  CanvasShell: () => <div data-testid="canvas-shell" />,
}))
jest.mock("@/components/shell/onboarding-dialog", () => ({
  OnboardingDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="onboarding" /> : null,
}))
jest.mock("@/components/chat/tool-approval-dialog", () => ({
  ToolApprovalDialog: () => null,
}))

import { DesktopChatWorkspace } from "./desktop-chat-workspace"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  select.mockReset()
  create.mockReset()
  remove.mockReset()
  rename.mockReset()
  bulkRemove.mockReset().mockResolvedValue(undefined)
  bulkSetPinned.mockReset().mockResolvedValue(undefined)
  setSelectedGuild.mockReset().mockImplementation((g: SelectedGuild) => {
    selectedGuild = g
  })
  clearPendingSettings.mockReset()
  loadSettings.mockClear()
  routerPush.mockReset()
  routerReplace.mockReset()
  sessionsRef.current = []
  activeSessionId = null
  selectedGuild = { kind: "dm" }
  errorMessageRef.current = null
  pendingSettingsRequestRef.current = null
  channelListPropsLog.length = 0
})

test("auto-selects a matching session on first render and logs", async () => {
  sessionsRef.current = [
    { id: "s-1", title: "x", kind: "direct", createdAt: 0, updatedAt: 0 } as unknown as ChatSession,
  ]
  render(<DesktopChatWorkspace />)
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
  render(<DesktopChatWorkspace />)
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
  render(<DesktopChatWorkspace />)
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings?section=skills"))
  expect(clearPendingSettings).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith(
    "open settings via deep-link",
    expect.objectContaining({ tab: "skills" })
  )
})

test("marks the chat <main> region as a scope-target for chat backgrounds", () => {
  const { container } = render(<DesktopChatWorkspace />)
  const main = container.querySelector("main[data-bg-target='chat']")
  expect(main).not.toBeNull()
})

test("ChannelList callback props stay referentially stable across re-renders", () => {
  sessionsRef.current = [
    { id: "s-1", title: "x", kind: "direct", createdAt: 0, updatedAt: 0 } as unknown as ChatSession,
  ]
  const { rerender } = render(<DesktopChatWorkspace />)
  expect(channelListPropsLog.length).toBeGreaterThanOrEqual(1)
  const firstProps = channelListPropsLog[channelListPropsLog.length - 1]

  // Force another render of the workspace without changing any dependency
  // that feeds the channel-list callbacks. useCallback should return the
  // same references.
  rerender(<DesktopChatWorkspace />)
  const secondProps = channelListPropsLog[channelListPropsLog.length - 1]

  expect(secondProps.onSelect).toBe(firstProps.onSelect)
  expect(secondProps.onNewDirect).toBe(firstProps.onNewDirect)
  expect(secondProps.onNewTeamConversation).toBe(firstProps.onNewTeamConversation)
  expect(secondProps.onDelete).toBe(firstProps.onDelete)
  expect(secondProps.onRename).toBe(firstProps.onRename)
  expect(secondProps.onBulkDelete).toBe(firstProps.onBulkDelete)
  expect(secondProps.onBulkSetPinned).toBe(firstProps.onBulkSetPinned)
  expect(secondProps.onTogglePinned).toBe(firstProps.onTogglePinned)
})

test("onBulkDelete delegates to bulkRemove and surfaces the i18n'd success toast", async () => {
  render(<DesktopChatWorkspace />)
  const props = channelListPropsLog[channelListPropsLog.length - 1]
  const onBulkDelete = props.onBulkDelete as (ids: string[]) => Promise<void>
  await act(async () => {
    await onBulkDelete(["s-1", "s-2"])
  })
  expect(bulkRemove).toHaveBeenCalledWith(["s-1", "s-2"])
  const { toast } = await import("sonner")
  expect((toast.success as jest.Mock).mock.calls.at(-1)?.[0]).toBe("deleteSuccess")
})

test("onBulkSetPinned(true) delegates to bulkSetPinned and toasts pinSuccess", async () => {
  render(<DesktopChatWorkspace />)
  const props = channelListPropsLog[channelListPropsLog.length - 1]
  const onBulkSetPinned = props.onBulkSetPinned as (ids: string[], pinned: boolean) => Promise<void>
  await act(async () => {
    await onBulkSetPinned(["s-1"], true)
  })
  expect(bulkSetPinned).toHaveBeenCalledWith(["s-1"], true)
  const { toast } = await import("sonner")
  expect((toast.success as jest.Mock).mock.calls.at(-1)?.[0]).toBe("pinSuccess")
})

test("onBulkSetPinned(false) routes to unpinSuccess toast", async () => {
  render(<DesktopChatWorkspace />)
  const props = channelListPropsLog[channelListPropsLog.length - 1]
  const onBulkSetPinned = props.onBulkSetPinned as (ids: string[], pinned: boolean) => Promise<void>
  await act(async () => {
    await onBulkSetPinned(["s-1", "s-2", "s-3"], false)
  })
  expect(bulkSetPinned).toHaveBeenCalledWith(["s-1", "s-2", "s-3"], false)
  const { toast } = await import("sonner")
  expect((toast.success as jest.Mock).mock.calls.at(-1)?.[0]).toBe("unpinSuccess")
})

test("per-row onTogglePinned routes through bulkSetPinned with a single-id list", async () => {
  render(<DesktopChatWorkspace />)
  const props = channelListPropsLog[channelListPropsLog.length - 1]
  const onTogglePinned = props.onTogglePinned as (id: string, pinned: boolean) => void
  await act(async () => {
    onTogglePinned("s-1", true)
    // Let the promise chain finish for the toast assertion below.
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(bulkSetPinned).toHaveBeenCalledWith(["s-1"], true)
})
