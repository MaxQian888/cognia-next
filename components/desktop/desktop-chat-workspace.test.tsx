/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { SelectedGuild } from "@/stores/ui"

const logInfo = jest.fn()
const logWarn = jest.fn()

jest.mock("next-intl", () => {
  // Keys this bundle is missing — `t.has` answers false for them, the way a
  // shell running an older message bundle than the code does.
  const missing = new Set<string>()
  return {
    useTranslations: () => {
      const t = (key: string) => key
      t.has = (key: string) => !missing.has(key)
      return t
    },
    __missingMessageKeys: missing,
  }
})
const missingMessageKeys = (jest.requireMock("next-intl") as { __missingMessageKeys: Set<string> })
  .__missingMessageKeys

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
let mockActiveProjectIdForSessions: string | null = null
jest.mock("@/hooks/chat", () => ({
  useSessions: ({ crossWorkspace = false }: { crossWorkspace?: boolean } = {}) => {
    const listedActiveSession =
      sessionsRef.current.find((session) => session.id === activeSessionId) ?? null
    const activeSession =
      crossWorkspace &&
      listedActiveSession?.projectId &&
      listedActiveSession.projectId !== mockActiveProjectIdForSessions
        ? null
        : listedActiveSession
    return {
      sessions: sessionsRef.current,
      activeSessionId,
      activeSession,
      activeSessionState: activeSession ? "present" : "absent",
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
    }
  },
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

let mockPlatform: "tauri" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockPlatform,
  detectPlatform: () => "desktop",
}))

let mockRuntimeSnapshotRef: import("@/lib/runtime/operation-availability").RuntimeSnapshot = {
  target: null,
  vaultState: "unavailable",
  connectionState: "offline",
}
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => mockRuntimeSnapshotRef,
}))

jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn().mockResolvedValue(undefined),
}))

// Stub heavy children — we only verify workspace wiring, not their internals.
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}))
const paneGroupPropsLog: Array<Record<string, unknown>> = []
const insertMention = jest.fn()
jest.mock("@/components/chat/chat-pane-group", () => ({
  ChatPaneGroup: (props: Record<string, unknown>) => {
    paneGroupPropsLog.push(props)
    // The composer handle the workspace threads down; the mention seam writes
    // through it, so the stub has to fill it the way the real composer does.
    const ref = props.composerRef as { current: { insertMention: unknown } | null } | undefined
    if (ref) ref.current = { insertMention }
    return <div data-testid="chat-pane-group" />
  },
}))
jest.mock("@/components/chat/workspace-trust-gate", () => ({
  WorkspaceTrustGate: () => null,
}))
jest.mock("@/components/chat/character-picker", () => ({
  CharacterPicker: ({ open, onPick }: { open: boolean; onPick: (c: unknown) => void }) =>
    open ? (
      <button
        data-testid="char-picker"
        onClick={() => onPick({ id: "c-pick", name: "Brainstorm Buddy" })}
      />
    ) : null,
}))
const channelListPropsLog: Array<Record<string, unknown>> = []
jest.mock("@/components/desktop/channel-list", () => ({
  ChannelList: (props: Record<string, unknown>) => {
    channelListPropsLog.push(props)
    const onSelect = props.onSelect as (id: string) => void
    return <button data-testid="channel-select-stub" onClick={() => onSelect("s-2")} />
  },
}))
jest.mock("@/components/artifacts/artifact-workspace-dock", () => ({
  ArtifactWorkspaceDock: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="artifact-workspace-dock">{children}</div>
  ),
}))
jest.mock("@/components/canvas/canvas-shell", () => ({
  CanvasShell: () => <div data-testid="canvas-shell" />,
}))
jest.mock("@/components/chat/tool-approval-dialog", () => ({
  ToolApprovalDialog: () => null,
}))

import { requestComposerMention } from "@/lib/chat/composer-mention-request"
import { DesktopChatWorkspace } from "./desktop-chat-workspace"
import { useProjectStore } from "@/stores/project/project-store"
import { toast } from "sonner"

beforeEach(() => {
  insertMention.mockReset()
  missingMessageKeys.clear()
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
  mockActiveProjectIdForSessions = null
  selectedGuild = { kind: "dm" }
  errorMessageRef.current = null
  pendingSettingsRequestRef.current = null
  mockPlatform = "tauri"
  mockRuntimeSnapshotRef = {
    target: null,
    vaultState: "unavailable",
    connectionState: "offline",
  }
  channelListPropsLog.length = 0
  paneGroupPropsLog.length = 0
  closeSessionStoreMock.mockClear()
  // The workspace-switch tests below write the real project store; reset it so
  // an `activeProjectId` never leaks into the guild-reconcile suites.
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
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

test("passes the active project root to the reusable execution-base picker", () => {
  const project = useProjectStore.getState().createProject({ name: "Workspace", rootDir: "/repo" })
  useProjectStore.getState().setActiveProject(project.id)

  render(<DesktopChatWorkspace />)

  const controls = paneGroupPropsLog.at(-1)?.newChatExecutionControls as
    { props?: { rootDir?: string } } | undefined
  expect(controls?.props?.rootDir).toBe("/repo")
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

test("selecting a conversation from another workspace switches the workspace first", async () => {
  // Everything downstream of the chat pane — artifacts, terminals, the
  // workspace panel — resolves against `activeProjectId`. Selecting without
  // following the conversation into its workspace leaves all of them pointed at
  // the one the user just left.
  useProjectStore.setState({ activeProjectId: "project-a", loaded: false })
  activeSessionId = "s-1"
  sessionsRef.current = [
    {
      id: "s-2",
      title: "elsewhere",
      kind: "direct",
      projectId: "project-b",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  render(<DesktopChatWorkspace />)
  await act(async () => {
    screen.getByTestId("channel-select-stub").click()
  })

  expect(useProjectStore.getState().activeProjectId).toBe("project-b")
  expect(select).toHaveBeenCalledWith("s-2")
  expect(logInfo).toHaveBeenCalledWith(
    "switch-to-session crosses workspace",
    expect.objectContaining({ sessionId: "s-2", projectId: "project-b" })
  )

  // Following is right, but doing it silently re-points the editor, terminal
  // and workspace panel at another project with nothing on screen saying so.
  expect(toast.info).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ action: expect.objectContaining({ label: expect.any(String) }) })
  )

  // The undo restores BOTH halves — reverting only the workspace would strand
  // the conversation reading as `absent`.
  const undo = jest.mocked(toast.info).mock.calls[0]?.[1] as unknown as {
    action: { onClick: () => void }
  }
  select.mockClear()
  act(() => undo.action.onClick())
  expect(useProjectStore.getState().activeProjectId).toBe("project-a")
  expect(select).toHaveBeenCalledWith("s-1")
})

test("selecting a conversation in the current workspace leaves the workspace alone", async () => {
  const setActiveProject = jest.spyOn(useProjectStore.getState(), "setActiveProject")
  useProjectStore.setState({ activeProjectId: "project-a", loaded: false })
  sessionsRef.current = [
    {
      id: "s-2",
      title: "here",
      kind: "direct",
      projectId: "project-a",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession,
  ]
  render(<DesktopChatWorkspace />)
  await act(async () => {
    screen.getByTestId("channel-select-stub").click()
  })

  expect(setActiveProject).not.toHaveBeenCalled()
  expect(useProjectStore.getState().activeProjectId).toBe("project-a")
  setActiveProject.mockRestore()
})

test("does not auto-select a foreign active conversation from the cross-workspace list", async () => {
  mockActiveProjectIdForSessions = "project-a"
  useProjectStore.setState({ activeProjectId: "project-a", loaded: true })
  sessionsRef.current = [
    {
      id: "foreign",
      title: "other workspace",
      kind: "direct",
      projectId: "project-b",
      createdAt: 0,
      updatedAt: 9,
    } as unknown as ChatSession,
  ]
  // The persisted active id belongs to another workspace, so useSessions
  // correctly resolves it as absent even though the cross-workspace sidebar
  // still lists the row. Re-selecting that same id bumps activeSessionEpoch and
  // makes this effect dispatch forever in the real Zustand-backed component.
  activeSessionId = "foreign"
  activeSessionEpoch = 9
  selectedGuildEpoch = 1

  render(<DesktopChatWorkspace />)

  await waitFor(() => expect(screen.getByTestId("chat-pane-group")).toBeInTheDocument())
  expect(select).not.toHaveBeenCalled()
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

test("an active team session renders the shared ChatPaneGroup, and no roster column of its own", async () => {
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
  // …and the roster is the workbench's `team-members` panel now, not a third
  // column this component mounts beside the chat.
  expect(screen.queryByTestId("team-members-panel")).toBeNull()
})

test("hands a mention request from outside its tree to the composer", async () => {
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })
  act(() => {
    requestComposerMention("Research Analyst")
  })
  expect(insertMention).toHaveBeenCalledWith("Research Analyst")
})

test("an ordinary Web browser renders the shared chat workspace", async () => {
  mockPlatform = "web"
  await act(async () => {
    render(<DesktopChatWorkspace />)
  })

  expect(screen.getByTestId("chat-pane-group")).toBeInTheDocument()
  expect(screen.queryByText("desktopOnlyTitle")).not.toBeInTheDocument()
})

test("an offline Companion keeps cached chat visible and disables sending with an explanation", async () => {
  mockPlatform = "web"
  mockRuntimeSnapshotRef = {
    target: {
      id: "desktop-studio",
      kind: "companion",
      platform: "web",
      hostKind: "desktop",
    },
    vaultState: "unlocked",
    connectionState: "offline",
    host: {
      compatible: true,
      operations: ["claude_send"],
      grants: ["agent.run"],
    },
  }

  await act(async () => {
    render(<DesktopChatWorkspace />)
  })

  expect(screen.getByTestId("chat-pane-group")).toBeInTheDocument()
  expect(screen.getByTestId("chat-runtime-notice")).toHaveTextContent("states.offline")
  expect(paneGroupPropsLog.at(-1)?.composerDisabled).toBe(true)
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
    send: (content: unknown, sid: string, manifest?: readonly unknown[]) => unknown
    stop: (sid: string) => unknown
    steerNow: (sid: string) => unknown
    steerFlush: (sid: string) => unknown
    regenerate: (sid: string) => unknown
    editResend: (id: string, content: unknown, sid: string) => unknown
    respondToApproval: (approval: unknown, decision: string) => unknown
  }

  const manifest = [{ filename: "report.txt", mediaType: "text/plain", kind: "document" }]
  await act(async () => {
    props.send("hi", "t-1", manifest)
    props.stop("t-1")
    props.steerNow("t-1")
    props.steerFlush("t-1")
    props.regenerate("t-1")
    props.editResend("m1", "edited", "t-1")
  })
  expect(teamChatMock.send).toHaveBeenCalledWith("hi", {
    sessionId: "t-1",
    attachmentManifest: manifest,
  })
  expect(teamChatMock.stop).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.interruptAndSteer).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.flushSteer).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.regenerate).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.editAndResend).toHaveBeenCalledWith("m1", "edited", "t-1")
  await act(async () => {
    props.send("hi", "d-1", manifest)
    props.stop("d-1")
    props.steerNow("d-1")
    props.steerFlush("d-1")
    props.regenerate("d-1")
    props.editResend("m2", "edited", "d-1")
  })
  expect(directChatMock.send).toHaveBeenCalledWith("hi", undefined, {
    sessionId: "d-1",
    attachmentManifest: manifest,
  })
  expect(directChatMock.stop).toHaveBeenCalledWith("d-1")
  expect(directChatMock.interruptAndSteer).toHaveBeenCalledWith("d-1")
  expect(directChatMock.flushSteer).toHaveBeenCalledWith("d-1")
  expect(directChatMock.regenerate).toHaveBeenCalledWith("d-1")
  expect(directChatMock.editAndResend).toHaveBeenCalledWith("m2", "edited", "d-1")
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

// The picked character's conversation title is persisted, so an unresolved
// message would name the conversation `desktop.memberList.chatTitle` for good —
// including in the shell that later ships the message.
test("names a picked character's conversation after them when the title message is missing", async () => {
  missingMessageKeys.add("chatTitle")
  create.mockResolvedValue({ id: "new-direct" } as ChatSession)
  render(<DesktopChatWorkspace />)
  const props = channelListPropsLog[channelListPropsLog.length - 1]
  await act(async () => {
    ;(props.onNewDirect as () => void)()
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId("char-picker"))
  })
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Brainstorm Buddy", kind: "direct", characterId: "c-pick" })
  )
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
