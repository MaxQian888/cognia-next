/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
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

jest.mock("@cognia/logging", () => ({
  loggers: {
    shell: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
    },
    ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    plugin: {
      trace: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: function () {
        return this
      },
      withContext: function () {
        return this
      },
    },
    agent: {
      trace: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: function () {
        return this
      },
      withContext: function () {
        return this
      },
    },
  },
  createLogger: () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child() {
      return this
    },
    withContext() {
      return this
    },
  }),
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
const archive = jest.fn().mockResolvedValue(undefined)
const unarchive = jest.fn().mockResolvedValue(undefined)
const bulkArchive = jest.fn().mockResolvedValue(undefined)
const bulkUnarchive = jest.fn().mockResolvedValue(undefined)
const createFolder = jest.fn().mockResolvedValue({ id: "f-new" })
const renameFolder = jest.fn().mockResolvedValue(undefined)
const deleteFolder = jest.fn().mockResolvedValue(undefined)
const assignToFolder = jest.fn().mockResolvedValue(undefined)
let activeSessionId: string | null = null
// Navigation epochs — mirror the real stores so the workspace can decide
// whether the guild or the active session was chosen more recently.
let navCounter = 0
let selectedGuildEpoch = 0
let activeSessionEpoch = 0
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
    archive,
    unarchive,
    bulkArchive,
    bulkUnarchive,
    folders: [],
    createFolder,
    renameFolder,
    deleteFolder,
    assignToFolder,
  }),
  useClaudeChat: () => directChatMock,
  useTeamChat: () => teamChatMock,
}))

// Stable hook mocks so the kind-dispatching pane callbacks can be asserted.
const directChatMock = {
  send: jest.fn(),
  stop: jest.fn(),
  interruptAndSteer: jest.fn(),
  flushSteer: jest.fn(),
  regenerate: jest.fn(),
  editAndResend: jest.fn(),
  respondToApproval: jest.fn(),
  close: jest.fn(),
}
const teamChatMock = {
  send: jest.fn(),
  stop: jest.fn(),
  interruptAndSteer: jest.fn(),
  flushSteer: jest.fn(),
  regenerate: jest.fn(),
  editAndResend: jest.fn(),
  respondToApproval: jest.fn(),
}

const errorMessageRef: { current: string | null } = { current: null }
const closeSessionStoreMock = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T,>(
      selector: (s: {
        errorMessage: string | null
        pendingApprovals: unknown[]
        activeSessionEpoch: number
      }) => T
    ): T =>
      selector({
        errorMessage: errorMessageRef.current,
        pendingApprovals: [],
        activeSessionEpoch,
      }),
    {
      getState: () => ({
        activeSessionId,
        closeSession: closeSessionStoreMock,
        setPermissionMode: jest.fn(),
      }),
    }
  ),
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
  selectedGuildEpoch = ++navCounter
})
const pendingSettingsRequestRef: { current: { tab?: string; nonce: number } | null } = {
  current: null,
}
const clearPendingSettings = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(
    selector: (s: {
      selectedGuild: SelectedGuild
      selectedGuildEpoch: number
      setSelectedGuild: typeof setSelectedGuild
      pendingSettingsRequest: typeof pendingSettingsRequestRef.current
      clearPendingSettings: typeof clearPendingSettings
      sidebarCollapsed: boolean
    }) => T
  ): T =>
    selector({
      selectedGuild,
      selectedGuildEpoch,
      setSelectedGuild,
      pendingSettingsRequest: pendingSettingsRequestRef.current,
      clearPendingSettings,
      sidebarCollapsed: false,
    }),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

// Render the real Tauri branch (ChatPaneGroup + trust gate) — the workspace
// no longer has a separate team ChatPane fork to exercise.
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => "tauri",
  detectPlatform: () => "desktop",
}))

jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn().mockResolvedValue(undefined),
}))

// Stub heavy children — we only verify workspace wiring, not their internals.
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}))
const paneGroupPropsLog: Array<Record<string, unknown>> = []
jest.mock("@/components/chat/chat-pane-group", () => ({
  ChatPaneGroup: (props: Record<string, unknown>) => {
    paneGroupPropsLog.push(props)
    return <div data-testid="chat-pane-group" />
  },
}))
jest.mock("@/components/chat/workspace-trust-gate", () => ({
  WorkspaceTrustGate: () => null,
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
jest.mock("@/components/artifacts/artifact-workspace-dock", () => ({
  ArtifactWorkspaceDock: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="artifact-workspace-dock">{children}</div>
  ),
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
  archive.mockReset().mockResolvedValue(undefined)
  unarchive.mockReset().mockResolvedValue(undefined)
  bulkArchive.mockReset().mockResolvedValue(undefined)
  bulkUnarchive.mockReset().mockResolvedValue(undefined)
  setSelectedGuild.mockReset().mockImplementation((g: SelectedGuild) => {
    selectedGuild = g
    selectedGuildEpoch = ++navCounter
  })
  clearPendingSettings.mockReset()
  loadSettings.mockClear()
  routerPush.mockReset()
  routerReplace.mockReset()
  sessionsRef.current = []
  activeSessionId = null
  navCounter = 0
  selectedGuildEpoch = 0
  activeSessionEpoch = 0
  selectedGuild = { kind: "dm" }
  errorMessageRef.current = null
  pendingSettingsRequestRef.current = null
  channelListPropsLog.length = 0
  paneGroupPropsLog.length = 0
  closeSessionStoreMock.mockClear()
  for (const m of Object.values(directChatMock)) m.mockClear()
  for (const m of Object.values(teamChatMock)) m.mockClear()
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

test("clicking a team (guild chosen most recently) resumes its latest conversation", async () => {
  sessionsRef.current = [
    { id: "d-1", title: "d", kind: "direct", createdAt: 0, updatedAt: 0 } as unknown as ChatSession,
    {
      id: "t-old",
      title: "o",
      kind: "team",
      teamId: "t-1",
      createdAt: 0,
      updatedAt: 1,
    } as unknown as ChatSession,
    {
      id: "t-new",
      title: "n",
      kind: "team",
      teamId: "t-1",
      createdAt: 0,
      updatedAt: 5,
    } as unknown as ChatSession,
  ]
  activeSessionId = "d-1"
  activeSessionEpoch = 1
  selectedGuild = { kind: "dm" }
  selectedGuildEpoch = 0
  const { rerender } = render(<DesktopChatWorkspace />)
  // The direct session is still the most recent intent — no reconciliation.
  expect(select).not.toHaveBeenCalled()
  // Rail switches to the team: the guild is now the most recent intent.
  selectedGuild = { kind: "team", teamId: "t-1" }
  selectedGuildEpoch = 5
  await act(async () => {
    rerender(<DesktopChatWorkspace />)
  })
  await waitFor(() => expect(select).toHaveBeenCalledWith("t-new"))
})

test("clicking a team with no conversations lands on the welcome state without creating", async () => {
  sessionsRef.current = [
    { id: "d-1", title: "d", kind: "direct", createdAt: 0, updatedAt: 0 } as unknown as ChatSession,
  ]
  activeSessionId = "d-1"
  activeSessionEpoch = 1
  selectedGuild = { kind: "team", teamId: "t-9" }
  selectedGuildEpoch = 5
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  // The reconcile clears the stale direct session so the welcome renders; it
  // must NOT silently insert a new team session row.
  await waitFor(() => expect(select).toHaveBeenCalledWith(null))
  expect(create).not.toHaveBeenCalled()
})

test("clears the active session when switching to an empty DM bucket", async () => {
  sessionsRef.current = [
    {
      id: "t-1",
      title: "t",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  activeSessionId = "t-1"
  activeSessionEpoch = 1
  selectedGuild = { kind: "dm" }
  selectedGuildEpoch = 5
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  await waitFor(() => expect(select).toHaveBeenCalledWith(null))
})

test("syncs the guild to the active session when the session is the most recent intent", async () => {
  sessionsRef.current = [
    {
      id: "t-1",
      title: "t",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  // A session resumed elsewhere (e.g. the settings page) is the latest intent
  // while the guild is still stale on DM — the guild should follow the session.
  activeSessionId = "t-1"
  activeSessionEpoch = 9
  selectedGuild = { kind: "dm" }
  selectedGuildEpoch = 1
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  await waitFor(() =>
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "team-x" })
  )
})

test("an empty team guild with no active session is a stable no-op", async () => {
  sessionsRef.current = []
  activeSessionId = null
  activeSessionEpoch = 1
  selectedGuild = { kind: "team", teamId: "t-x" }
  selectedGuildEpoch = 5
  const { rerender } = render(<DesktopChatWorkspace />)
  // Nothing to resume and nothing to clear: no session mutation of any kind.
  selectedGuildEpoch = 6
  await act(async () => {
    rerender(<DesktopChatWorkspace />)
  })
  expect(create).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})

test("does not recreate a conversation after the team's last one is deleted", async () => {
  // The team has no sessions and the active id was just cleared by the delete,
  // so the session (the clear) is the most recent navigation intent.
  sessionsRef.current = []
  activeSessionId = null
  activeSessionEpoch = 9
  selectedGuild = { kind: "team", teamId: "t-1" }
  selectedGuildEpoch = 5
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  expect(create).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})

test("an active team session renders the shared ChatPaneGroup plus the MemberList", async () => {
  sessionsRef.current = [
    {
      id: "t-1",
      title: "team chat",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  activeSessionId = "t-1"
  activeSessionEpoch = 5
  selectedGuild = { kind: "team", teamId: "team-x" }
  selectedGuildEpoch = 6
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  // One shared multi-pane surface for team and direct sessions alike…
  expect(screen.getByTestId("chat-pane-group")).toBeInTheDocument()
  expect(screen.queryByTestId("chat-pane")).not.toBeInTheDocument()
  // …with the team chrome still attached.
  expect(screen.getByTestId("member-list")).toBeInTheDocument()
})

test("the pane group's onCreate starts a team conversation while a team guild is selected", async () => {
  create.mockResolvedValue({ id: "fresh" })
  sessionsRef.current = [
    {
      id: "t-1",
      title: "team chat",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  activeSessionId = "t-1"
  activeSessionEpoch = 5
  selectedGuild = { kind: "team", teamId: "team-x" }
  selectedGuildEpoch = 6
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  const props = paneGroupPropsLog[paneGroupPropsLog.length - 1]
  await act(async () => {
    ;(props.onCreate as () => void)()
  })
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "team", teamId: "team-x" }))
  )
  expect(select).toHaveBeenCalledWith("fresh")
  // No approval modal is mounted anymore — approvals ride the inline gates.
  expect(screen.queryByTestId("tool-approval-dialog")).not.toBeInTheDocument()
})

test("pane callbacks dispatch by session kind (team → useTeamChat, direct → useClaudeChat)", async () => {
  sessionsRef.current = [
    {
      id: "t-1",
      title: "team chat",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
    {
      id: "d-1",
      title: "dm",
      kind: "direct",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  activeSessionId = "t-1"
  activeSessionEpoch = 5
  selectedGuild = { kind: "team", teamId: "team-x" }
  selectedGuildEpoch = 6
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  const props = paneGroupPropsLog[paneGroupPropsLog.length - 1] as {
    send: (content: unknown, sid: string) => unknown
    stop: (sid: string) => unknown
    steerNow: (sid: string) => unknown
    steerFlush: (sid: string) => unknown
    regenerate: (sid: string) => unknown
    editResend: (id: string, content: unknown, sid: string) => unknown
    closePane: (sid: string) => void
    respondToApproval: (approval: unknown, decision: string) => unknown
  }

  await act(async () => {
    props.send("hi", "t-1")
    props.stop("t-1")
    props.steerNow("t-1")
    props.steerFlush("t-1")
    props.regenerate("t-1")
    props.editResend("m1", "edited", "t-1")
    props.closePane("t-1")
  })
  expect(teamChatMock.send).toHaveBeenCalledWith("hi", { sessionId: "t-1" })
  expect(teamChatMock.stop).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.interruptAndSteer).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.flushSteer).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.regenerate).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.editAndResend).toHaveBeenCalledWith("m1", "edited", "t-1")
  // Team pane close only drops the store slice — sub-sessions are torn down
  // per turn by useTeamChat.
  expect(closeSessionStoreMock).toHaveBeenCalledWith("t-1")
  expect(directChatMock.close).not.toHaveBeenCalled()

  await act(async () => {
    props.send("hi", "d-1")
    props.stop("d-1")
    props.steerNow("d-1")
    props.steerFlush("d-1")
    props.regenerate("d-1")
    props.editResend("m2", "edited", "d-1")
    props.closePane("d-1")
  })
  expect(directChatMock.send).toHaveBeenCalledWith("hi", undefined, { sessionId: "d-1" })
  expect(directChatMock.stop).toHaveBeenCalledWith("d-1")
  expect(directChatMock.interruptAndSteer).toHaveBeenCalledWith("d-1")
  expect(directChatMock.flushSteer).toHaveBeenCalledWith("d-1")
  expect(directChatMock.regenerate).toHaveBeenCalledWith("d-1")
  expect(directChatMock.editAndResend).toHaveBeenCalledWith("m2", "edited", "d-1")
  expect(directChatMock.close).toHaveBeenCalledWith("d-1")

  // Approval routing: sub-session ids go to the team hook, plain ids direct.
  const teamApproval = { sessionId: "t-1::char::alice::turn", requestId: "r1" }
  const directApproval = { sessionId: "d-1", requestId: "r2" }
  await act(async () => {
    props.respondToApproval(teamApproval, "allow")
    props.respondToApproval(directApproval, "deny")
  })
  expect(teamChatMock.respondToApproval).toHaveBeenCalledWith(teamApproval, "allow")
  expect(directChatMock.respondToApproval).toHaveBeenCalledWith(directApproval, "deny")
})

// The welcome page has no session yet, so a starter card must create one before
// it can send — otherwise the send guard drops the prompt and the click reads as
// a dead button.
test("welcome starter card creates a session, then sends the prompt into it", async () => {
  sessionsRef.current = []
  activeSessionId = null
  create.mockResolvedValue({ id: "new-1" } as ChatSession)

  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  const props = paneGroupPropsLog[paneGroupPropsLog.length - 1] as {
    onUseSample: (text: string) => void
  }

  await act(async () => {
    props.onUseSample("draft a commit message")
  })

  expect(create).toHaveBeenCalledTimes(1)
  // Explicit sessionId — the store pointer may not have propagated yet.
  expect(directChatMock.send).toHaveBeenCalledWith("draft a commit message", undefined, {
    sessionId: "new-1",
  })
})

test("welcome starter card starts a team conversation when a team guild is selected", async () => {
  sessionsRef.current = []
  activeSessionId = null
  selectedGuild = { kind: "team", teamId: "team-x" }
  selectedGuildEpoch = 6
  create.mockResolvedValue({ id: "new-t" } as ChatSession)

  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  const props = paneGroupPropsLog[paneGroupPropsLog.length - 1] as {
    onUseSample: (text: string) => void
  }

  await act(async () => {
    props.onUseSample("plan the sprint")
  })

  expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "team", teamId: "team-x" }))
  expect(teamChatMock.send).toHaveBeenCalledWith("plan the sprint", { sessionId: "new-t" })
  expect(directChatMock.send).not.toHaveBeenCalled()
})

test("starter card sends into the existing session without creating a new one", async () => {
  sessionsRef.current = [
    {
      id: "d-1",
      title: "dm",
      kind: "direct",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  activeSessionId = "d-1"

  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  const props = paneGroupPropsLog[paneGroupPropsLog.length - 1] as {
    onUseSample: (text: string) => void
  }

  await act(async () => {
    props.onUseSample("review this")
  })

  expect(create).not.toHaveBeenCalled()
  expect(directChatMock.send).toHaveBeenCalledWith("review this", undefined, { sessionId: "d-1" })
})

test("starter card routes to the team hook for an active team session", async () => {
  sessionsRef.current = [
    {
      id: "t-1",
      title: "team chat",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  activeSessionId = "t-1"
  activeSessionEpoch = 5
  selectedGuild = { kind: "team", teamId: "team-x" }
  selectedGuildEpoch = 6

  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  const props = paneGroupPropsLog[paneGroupPropsLog.length - 1] as {
    onUseSample: (text: string) => void
  }

  await act(async () => {
    props.onUseSample("summarize the thread")
  })

  expect(create).not.toHaveBeenCalled()
  expect(teamChatMock.send).toHaveBeenCalledWith("summarize the thread", { sessionId: "t-1" })
  expect(directChatMock.send).not.toHaveBeenCalled()
})

test("resumeAfterPlanApproval is a guarded no-op for team sessions", async () => {
  sessionsRef.current = [
    {
      id: "t-1",
      title: "team chat",
      kind: "team",
      teamId: "team-x",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  activeSessionId = "t-1"
  activeSessionEpoch = 5
  selectedGuild = { kind: "team", teamId: "team-x" }
  selectedGuildEpoch = 6
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  const props = paneGroupPropsLog[paneGroupPropsLog.length - 1] as {
    onResumeAfterPlanApproval: (prompt: string, mode: string, sid: string) => Promise<void>
  }
  await act(async () => {
    await props.onResumeAfterPlanApproval("resume", "acceptEdits", "t-1")
  })
  expect(directChatMock.send).not.toHaveBeenCalled()
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

test("onBulkArchive delegates to bulkArchive and toasts archiveSuccess", async () => {
  render(<DesktopChatWorkspace />)
  const props = channelListPropsLog[channelListPropsLog.length - 1]
  const onBulkArchive = props.onBulkArchive as (ids: string[]) => Promise<void>
  await act(async () => {
    await onBulkArchive(["s-1", "s-2"])
  })
  expect(bulkArchive).toHaveBeenCalledWith(["s-1", "s-2"])
  const { toast } = await import("sonner")
  expect((toast.success as jest.Mock).mock.calls.at(-1)?.[0]).toBe("archiveSuccess")
})

test("onBulkUnarchive delegates to the transactional bulkUnarchive and toasts unarchiveSuccess", async () => {
  render(<DesktopChatWorkspace />)
  const props = channelListPropsLog[channelListPropsLog.length - 1]
  const onBulkUnarchive = props.onBulkUnarchive as (ids: string[]) => Promise<void>
  await act(async () => {
    await onBulkUnarchive(["s-1", "s-2"])
  })
  expect(bulkUnarchive).toHaveBeenCalledWith(["s-1", "s-2"])
  const { toast } = await import("sonner")
  expect((toast.success as jest.Mock).mock.calls.at(-1)?.[0]).toBe("unarchiveSuccess")
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
