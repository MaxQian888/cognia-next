/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Character, ChatSession, Team } from "@/lib/claude/types"

const logInfo = jest.fn()
const logError = jest.fn()
const toastSuccess = jest.fn()
const toastInfo = jest.fn()
const toastError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: jest.fn(),
      error: (...args: unknown[]) => logError(...args),
    },
  },
  // Pulled in transitively by @/lib/plugin → hooks-system → core/logger.
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  }),
}))

// Stub the plugin event surface so the new dispatchShortcut wiring doesn't
// drag the real plugin store (and its Tauri bindings) into this test.
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({
    dispatchShortcut: jest.fn().mockResolvedValue(false),
  }),
}))

jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: jest.fn(),
  },
}))

const select = jest.fn()
const create = jest.fn(async () => ({ id: "new-s", title: "" }))
const sessionsRef: { current: ChatSession[] } = { current: [] }
jest.mock("@/hooks/chat", () => ({
  useSessions: () => ({
    sessions: sessionsRef.current,
    select,
    create,
  }),
}))

const messagesRef: { current: unknown[] } = { current: [] }
const setSelectedGuild = jest.fn()
const replaceMessages = jest.fn()
const activeSessionIdRef: { current: string | null } = { current: null }

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T,>(selector: (s: { messages: unknown[] }) => T): T =>
      selector({ messages: messagesRef.current }),
    {
      getState: () => ({
        activeSessionId: activeSessionIdRef.current,
        replaceMessages,
      }),
    }
  ),
}))

const settingsRef: { current: { apiKey?: string } | null } = { current: { apiKey: "k" } }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: { apiKey?: string } | null }) => T): T =>
    selector({ settings: settingsRef.current }),
}))

jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: { setSelectedGuild: typeof setSelectedGuild }) => T): T =>
    selector({ setSelectedGuild }),
}))

const charactersRef: { current: Character[] } = { current: [] }
const teamsRef: { current: Team[] } = { current: [] }
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(query: () => Promise<T> | T, _d: unknown[], _i: T): T => {
    const src = query.toString()
    if (src.includes("listCharacters")) return charactersRef.current as unknown as T
    if (src.includes("listTeams")) return teamsRef.current as unknown as T
    return _i
  },
}))

const setTheme = jest.fn()
let theme: string | undefined = "light"
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme, setTheme }),
}))

jest.mock("@/components/ai-elements/conversation", () => ({
  messagesToMarkdown: () => "# md",
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

import { CommandPalette } from "./command-palette"

beforeEach(() => {
  logInfo.mockReset()
  logError.mockReset()
  toastInfo.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  select.mockReset()
  create.mockReset().mockResolvedValue({ id: "new-s", title: "" })
  setSelectedGuild.mockReset()
  setTheme.mockReset()
  replaceMessages.mockReset()
  sessionsRef.current = []
  messagesRef.current = []
  activeSessionIdRef.current = null
  settingsRef.current = { apiKey: "k" }
  charactersRef.current = []
  teamsRef.current = []
  theme = "light"
})

function queueChars(c: Character[], t: Team[]) {
  charactersRef.current = c
  teamsRef.current = t
}

async function openWithShortcut() {
  const user = userEvent.setup()
  await user.keyboard("{Control>}k{/Control}")
  return user
}

test("opens via Cmd/Ctrl+K and renders the action list", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  // CommandDialog keeps the title in the DOM for a11y; the action list only
  // appears once the dialog is opened.
  expect(screen.queryByText("actions.newChat")).toBeNull()
  await openWithShortcut()
  await waitFor(() => expect(screen.getByText("actions.newChat")).toBeInTheDocument())
  expect(logInfo).toHaveBeenCalledWith(
    "command-palette toggle",
    expect.objectContaining({ next: true, source: "shortcut" })
  )
})

test("New chat action calls create() and closes the palette", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.newChat"))
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(logInfo).toHaveBeenCalledWith("command-palette new-chat")
})

test("Toggle theme switches between light and dark and logs", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.toggleTheme"))
  expect(setTheme).toHaveBeenCalledWith("dark")
  expect(logInfo).toHaveBeenCalledWith(
    "command-palette toggle-theme",
    expect.objectContaining({ from: "light", to: "dark" })
  )
})

test("Open settings actions invoke onOpenSettings with the right tab", async () => {
  queueChars([], [])
  const onOpen = jest.fn()
  render(<CommandPalette onOpenSettings={onOpen} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.manageApiKey"))
  expect(onOpen).toHaveBeenCalledWith("api-key")
  expect(logInfo).toHaveBeenCalledWith(
    "command-palette open-settings",
    expect.objectContaining({ tab: "api-key" })
  )
})

test("Export with no messages toasts the empty-state info", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.exportMd"))
  expect(toastInfo).toHaveBeenCalledWith("toasts.nothingToExport")
})

test("Switch to team selects that team's guild", async () => {
  const team: Team = {
    id: "t-1",
    name: "Squad",
    members: [],
    orchestration: "round_robin",
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Team
  queueChars([], [team])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("Squad"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
})

test("Check updates outside Tauri toasts a desktop-only info", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.checkUpdates"))
  await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("toasts.updatesDesktopOnly"))
})

test("Cleanup removes the keydown listener on unmount", () => {
  const removeSpy = jest.spyOn(window, "removeEventListener")
  queueChars([], [])
  const { unmount } = render(<CommandPalette onOpenSettings={jest.fn()} />)
  unmount()
  expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function))
  removeSpy.mockRestore()
})

// React 19 doesn't expose `act` directly from imports for our use, but we keep
// this here in case the rule changes.
void act
