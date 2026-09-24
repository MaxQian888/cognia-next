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

// Every namespace answers: the import graph reaches modules that build a
// child logger at load time (`loggers.mcp.child(...)` in lib/db/mcp-servers.ts,
// among others), and a hand-listed set of namespaces broke the whole suite
// every time that graph grew. `shell` keeps its spies for the assertions below.
jest.mock("@cognia/logging", () => {
  const makeLogger = (): Record<string, unknown> => {
    const logger: Record<string, unknown> = {
      trace: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    logger.child = () => logger
    logger.withContext = () => logger
    return logger
  }
  const shell = {
    ...makeLogger(),
    info: (...args: unknown[]) => logInfo(...args),
    warn: (...args: unknown[]) => logWarn(...args),
  }
  const byNamespace = new Map<PropertyKey, Record<string, unknown>>([["shell", shell]])
  return {
    loggers: new Proxy(
      {},
      {
        get: (_target, namespace) => {
          let logger = byNamespace.get(namespace)
          if (!logger) {
            logger = makeLogger()
            byNamespace.set(namespace, logger)
          }
          return logger
        },
      }
    ),
    createLogger: () => makeLogger(),
  }
})

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
const bulkAssignToFolder = jest.fn().mockResolvedValue(undefined)
// Every `crossWorkspace` the workspace asked `useSessions` for, in order.
const useSessionsCrossWorkspace: boolean[] = []
let activeSessionId: string | null = null
// Navigation epochs — mirror the real stores so the workspace can decide
// whether the guild or the active session was chosen more recently.
let navCounter = 0
let selectedGuildEpoch = 0
let activeSessionEpoch = 0
let mockActiveProjectIdForSessions: string | null = null
jest.mock("@/hooks/chat", () => ({
  useSessions: ({ crossWorkspace = false }: { crossWorkspace?: boolean } = {}) => {
    useSessionsCrossWorkspace.push(crossWorkspace)
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
      bulkAssignToFolder,
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
const clearActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T,>(
      selector: (s: {
        errorMessage: string | null
        pendingApprovals: unknown[]
        activeSessionEpoch: number
        clearActiveSession: typeof clearActiveSession
      }) => T
    ): T =>
      selector({
        errorMessage: errorMessageRef.current,
        pendingApprovals: [],
        activeSessionEpoch,
        clearActiveSession,
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
// The conversation-sidebar preferences the workspace reads to scope the query.
let mockConversationSidebar: Record<string, unknown> | undefined
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    <T,>(
      selector: (s: {
        load: typeof loadSettings
        settings: { conversationSidebar?: Record<string, unknown> }
      }) => T
    ): T =>
      selector({ load: loadSettings, settings: { conversationSidebar: mockConversationSidebar } }),
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
const requestChatHome = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(
    selector: (s: {
      selectedGuild: SelectedGuild
      selectedGuildEpoch: number
      setSelectedGuild: typeof setSelectedGuild
      pendingSettingsRequest: typeof pendingSettingsRequestRef.current
      clearPendingSettings: typeof clearPendingSettings
      sidebarCollapsed: boolean
      chatHomeEpoch: number
      requestChatHome: typeof requestChatHome
    }) => T
  ): T =>
    selector({
      selectedGuild,
      selectedGuildEpoch,
      setSelectedGuild,
      pendingSettingsRequest: pendingSettingsRequestRef.current,
      clearPendingSettings,
      sidebarCollapsed: false,
      chatHomeEpoch: 0,
      requestChatHome,
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
  getSessionState: jest.fn().mockResolvedValue(undefined),
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
    return <div data-testid="chat-pane-group">{props.runtimeNotice as React.ReactNode}</div>
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
import { ContextBar } from "@/components/chat/composer/context-bar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { primaryRootOf } from "@/lib/workspace/roots"
import type { Project } from "@/types"
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
  clearActiveSession.mockClear()
  requestChatHome.mockClear()
  bulkAssignToFolder.mockClear()
  useSessionsCrossWorkspace.length = 0
  mockConversationSidebar = undefined
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

// Contract since 482da24ad ("sidebar scope tree…"): the welcome surface's
// execution controls are the composer's `ContextBar`, which takes the active
// PROJECT (and resolves its roots itself) plus the new-chat execution
// selection — not the retired picker's bare `rootDir` string.
test("hands the active project and the new-chat execution to the welcome context bar", () => {
  const project = useProjectStore.getState().createProject({ name: "Workspace", rootDir: "/repo" })
  useProjectStore.getState().setActiveProject(project.id)

  render(<DesktopChatWorkspace />)

  const slot = paneGroupPropsLog.at(-1)?.welcomeContextBarSlot as
    | {
        type?: unknown
        props?: {
          project?: Project
          execution?: unknown
          onExecutionChange?: unknown
        }
      }
    | undefined
  expect(slot?.type).toBe(ContextBar)
  expect(slot?.props?.project?.id).toBe(project.id)
  // The project it gets is the one whose primary root is the workspace's repo.
  expect(primaryRootOf(slot!.props!.project!)?.path).toBe("/repo")
  expect(slot?.props?.execution).toEqual(expect.objectContaining({ location: expect.any(String) }))
  expect(slot?.props?.onExecutionChange).toEqual(expect.any(Function))
})

test("gives the welcome context bar no project while none is active", () => {
  render(<DesktopChatWorkspace />)
  const slot = paneGroupPropsLog.at(-1)?.welcomeContextBarSlot as
    { props?: { project?: Project } } | undefined
  expect(slot?.props?.project).toBeUndefined()
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
  // must NOT silently insert a new team session row. Since 482da24ad the clear
  // goes through `clearActiveSession`, which drops the pointer WITHOUT
  // stamping a navigation epoch — `select(null)` stamped one, and that newer
  // "the user navigated to nothing" intent outranked the guild pick that
  // produced it, bouncing the reconcile straight back.
  await waitFor(() => expect(clearActiveSession).toHaveBeenCalledTimes(1))
  expect(select).not.toHaveBeenCalled()
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
  // Epoch-free clear (482da24ad): see the team-without-conversations case.
  await waitFor(() => expect(clearActiveSession).toHaveBeenCalledTimes(1))
  expect(select).not.toHaveBeenCalled()
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

describe("where the welcome composer may address a runtime", () => {
  // A team room routes `@Name` through its own router and its send carries no
  // runtime route, so the welcome composer must not offer `@codex` when its
  // first turn is going into one.
  const lastHeroRouting = () => paneGroupPropsLog.at(-1)?.heroRouting

  test("into a new direct chat: routes", async () => {
    sessionsRef.current = []
    activeSessionId = null
    activeSessionEpoch = 1
    selectedGuild = { kind: "dm" }
    selectedGuildEpoch = 2
    await act(async () => {
      render(<DesktopChatWorkspace />)
    })
    expect(lastHeroRouting()).toBe(true)
  })

  test("into a new conversation of the selected team guild: does not", async () => {
    sessionsRef.current = []
    activeSessionId = null
    activeSessionEpoch = 1
    selectedGuild = { kind: "team", teamId: "t-x" }
    selectedGuildEpoch = 2
    await act(async () => {
      render(<DesktopChatWorkspace />)
    })
    expect(lastHeroRouting()).toBe(false)
  })

  test("into an active team room: does not", async () => {
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
    expect(lastHeroRouting()).toBe(false)
  })
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

// Contract since 482da24ad: the pane's "new conversation" action (composer
// /clear, the welcome CTA) goes HOME in the current scope — the team guild's own
// welcome — instead of inserting an empty team session up front. The team's
// conversation is created by the welcome's first send (`handleFirstTurn`).
test("the pane group's onCreate goes to the team's welcome, and its first send creates the conversation", async () => {
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
  // Home in the current scope: no guild argument, so the team guild stays.
  expect(requestChatHome).toHaveBeenCalledTimes(1)
  expect(requestChatHome).toHaveBeenCalledWith()
  expect(create).not.toHaveBeenCalled()

  // The welcome (no active conversation now) sends its first message: that is
  // what creates the team's conversation, in the selected team.
  activeSessionId = null
  const latest = paneGroupPropsLog[paneGroupPropsLog.length - 1]
  await act(async () => {
    await (latest.onHeroSend as (text: string) => Promise<void>)("kick-off")
  })
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "team", teamId: "team-x" }))
  expect(select).toHaveBeenCalledWith("fresh")
  expect(teamChatMock.send).toHaveBeenCalledWith(
    "kick-off",
    expect.objectContaining({ sessionId: "fresh" })
  )
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
    send: (
      content: unknown,
      sid: string,
      manifest?: readonly unknown[],
      templateRun?: unknown,
      turnMetadata?: unknown
    ) => unknown
    stop: (sid: string) => unknown
    steerNow: (sid: string) => unknown
    steerFlush: (sid: string) => unknown
    regenerate: (sid: string) => unknown
    editResend: (id: string, content: unknown, sid: string) => unknown
    respondToApproval: (approval: unknown, decision: string) => unknown
  }

  const manifest = [{ filename: "report.txt", mediaType: "text/plain", kind: "document" }]
  const turnMetadata = {
    webSearchContext: {
      provider: "tavily",
      results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
    },
  }
  await act(async () => {
    props.send("hi", "t-1", manifest, null, turnMetadata)
    props.stop("t-1")
    props.steerNow("t-1")
    props.steerFlush("t-1")
    props.regenerate("t-1")
    props.editResend("m1", "edited", "t-1")
  })
  expect(teamChatMock.send).toHaveBeenCalledWith("hi", {
    templateRun: undefined,
    sessionId: "t-1",
    attachmentManifest: manifest,
    webSearchContext: turnMetadata.webSearchContext,
  })
  expect(teamChatMock.stop).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.interruptAndSteer).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.flushSteer).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.regenerate).toHaveBeenCalledWith("t-1")
  expect(teamChatMock.editAndResend).toHaveBeenCalledWith("m1", "edited", "t-1")
  await act(async () => {
    props.send("hi", "d-1", manifest, null, turnMetadata)
    props.stop("d-1")
    props.steerNow("d-1")
    props.steerFlush("d-1")
    props.regenerate("d-1")
    props.editResend("m2", "edited", "d-1")
  })
  expect(directChatMock.send).toHaveBeenCalledWith("hi", undefined, {
    sessionId: "d-1",
    attachmentManifest: manifest,
    templateRun: null,
    webSearchContext: turnMetadata.webSearchContext,
  })
  expect(directChatMock.stop).toHaveBeenCalledWith("d-1")
  expect(directChatMock.interruptAndSteer).toHaveBeenCalledWith("d-1")
  expect(directChatMock.flushSteer).toHaveBeenCalledWith("d-1")
  expect(directChatMock.regenerate).toHaveBeenCalledWith("d-1")
  expect(directChatMock.editAndResend).toHaveBeenCalledWith("m2", "edited", "d-1")
  expect(props.respondToApproval).toBeUndefined()
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

test("leaves plan approval capability to the shared pane", async () => {
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
  expect(props.onResumeAfterPlanApproval).toBeUndefined()
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
//
// Since 482da24ad the picker's door is the welcome composer's "chat as a
// character" button (`welcomeComposerToolbar`, and the pane's `onPickCharacter`)
// — the sidebar's New chat lands on the welcome instead (next test).
test("names a picked character's conversation after them when the title message is missing", async () => {
  missingMessageKeys.add("chatTitle")
  create.mockResolvedValue({ id: "new-direct" } as ChatSession)
  render(<DesktopChatWorkspace />)
  expect(screen.queryByTestId("char-picker")).toBeNull()
  // The real toolbar element the workspace hands the welcome composer.
  const toolbar = paneGroupPropsLog.at(-1)?.welcomeComposerToolbar as React.ReactNode
  const { getByTestId } = render(<TooltipProvider>{toolbar}</TooltipProvider>)
  await act(async () => {
    fireEvent.click(getByTestId("welcome-character-entry"))
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId("char-picker"))
  })
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Brainstorm Buddy", kind: "direct", characterId: "c-pick" })
  )
  expect(select).toHaveBeenCalledWith("new-direct")
  expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "dm" })
})

test("the pane's own pick-a-character action opens the same picker", async () => {
  render(<DesktopChatWorkspace />)
  await act(async () => {
    ;(paneGroupPropsLog.at(-1)?.onPickCharacter as () => void)()
  })
  expect(screen.getByTestId("char-picker")).toBeInTheDocument()
})

test("the sidebar's New chat lands on the welcome instead of opening the picker", async () => {
  // 482da24ad: "Every 'New chat' affordance in the DM scope lands on the welcome
  // surface" — nothing is created up front, and the picker stays closed.
  render(<DesktopChatWorkspace />)
  const props = channelListPropsLog[channelListPropsLog.length - 1]
  await act(async () => {
    ;(props.onNewDirect as () => void)()
  })
  expect(requestChatHome).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId("char-picker")).toBeNull()
  expect(create).not.toHaveBeenCalled()
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
  const view = render(<DesktopChatWorkspace />)
  await act(async () => {})
  expect(markSessionRead).not.toHaveBeenCalled()
  activeSessionId = "local"
  sessionsRef.current = [
    { id: "local", title: "Local", kind: "direct", createdAt: 0, updatedAt: 0 } as ChatSession,
  ]
  view.rerender(<DesktopChatWorkspace />)
  await waitFor(() => expect(markSessionRead).toHaveBeenCalledWith("local"))
})

test.each([false, true])(
  "hero team send normalizes an absent template for existing=%s",
  async (existing) => {
    selectedGuild = { kind: "team", teamId: "team-x" }
    selectedGuildEpoch = 6
    activeSessionId = existing ? "t-1" : null
    sessionsRef.current = existing
      ? [
          {
            id: "t-1",
            title: "Team",
            kind: "team",
            teamId: "team-x",
            createdAt: 0,
            updatedAt: 0,
          } as ChatSession,
        ]
      : []
    create.mockResolvedValue({ id: "new-team" } as ChatSession)
    await act(async () => {
      render(<DesktopChatWorkspace />)
    })
    const props = paneGroupPropsLog.at(-1) as {
      onHeroSend: (text: string, manifest: undefined, templateRun: null) => Promise<void>
    }
    await act(async () => {
      await props.onHeroSend("hello", undefined, null)
    })
    expect(teamChatMock.send).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        sessionId: existing ? "t-1" : "new-team",
        templateRun: undefined,
      })
    )
  }
)

describe("sidebar wiring", () => {
  const latestListProps = () => channelListPropsLog[channelListPropsLog.length - 1]!

  test("loads every workspace only for the grouping the list actually draws", () => {
    // Stored `groupBy: "workspace"` (the default) used to load every
    // workspace's chats into the merged rail — a team-axis scope tree.
    mockConversationSidebar = { groupBy: "workspace" }
    render(<DesktopChatWorkspace />)
    expect(useSessionsCrossWorkspace.at(-1)).toBe(true)
    const report = latestListProps().onEffectiveGroupByChange as (g: string | null) => void
    act(() => report("team"))
    expect(useSessionsCrossWorkspace.at(-1)).toBe(false)
    // No list mounted any more (the Sheet closed): the stored preference again.
    act(() => report(null))
    expect(useSessionsCrossWorkspace.at(-1)).toBe(true)
  })

  test("still loads every workspace when search is told to reach them", () => {
    mockConversationSidebar = { groupBy: "workspace", search: { workspace: "all" } }
    render(<DesktopChatWorkspace />)
    const report = latestListProps().onEffectiveGroupByChange as (g: string | null) => void
    act(() => report("team"))
    expect(useSessionsCrossWorkspace.at(-1)).toBe(true)
  })

  test("keeps one onSelect across session updates, and it reads the latest list", () => {
    // It reaches every memoized sidebar row: a new identity per session write
    // re-rendered all of them several times a second while a reply streamed.
    sessionsRef.current = [{ id: "s-1", title: "A", kind: "direct", createdAt: 0, updatedAt: 0 }]
    const { rerender } = render(<DesktopChatWorkspace />)
    const onSelect = latestListProps().onSelect as (id: string) => void
    sessionsRef.current = [
      ...sessionsRef.current,
      { id: "s-9", title: "T", kind: "team", teamId: "t-1", createdAt: 0, updatedAt: 0 },
    ]
    rerender(<DesktopChatWorkspace />)
    expect(latestListProps().onSelect).toBe(onSelect)
    act(() => onSelect("s-9"))
    expect(select).toHaveBeenCalledWith("s-9")
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "team", teamId: "t-1" })
  })

  test("files a selection through the batch writer and says how many moved", async () => {
    render(<DesktopChatWorkspace />)
    const move = latestListProps().onBulkAssignToFolder as (
      ids: string[],
      folderId: string | null
    ) => Promise<void>
    const { toast } = await import("sonner")
    await act(async () => {
      await move(["s-1", "s-2"], "f-1")
    })
    expect(bulkAssignToFolder).toHaveBeenCalledWith(["s-1", "s-2"], "f-1")
    expect((toast.success as jest.Mock).mock.calls.at(-1)?.[0]).toBe("moveSuccess")
    await act(async () => {
      await move(["s-1"], null)
    })
    expect(bulkAssignToFolder).toHaveBeenLastCalledWith(["s-1"], null)
    expect((toast.success as jest.Mock).mock.calls.at(-1)?.[0]).toBe("removeFromFolderSuccess")
  })
})
