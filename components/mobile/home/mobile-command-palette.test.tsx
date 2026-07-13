/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Character, ChatSession, Team } from "@cognia/agent-config-types"
import type { WorkflowRow } from "@/types/workflow/visual"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}))

jest.mock("@cognia/logging", () => ({
  loggers: { ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  }),
}))

const select = jest.fn()
const create = jest.fn(async () => ({ id: "new-s", title: "" }))
const sessionsRef: { current: ChatSession[] } = { current: [] }
jest.mock("@/hooks/chat", () => ({
  useSessions: () => ({ sessions: sessionsRef.current, select, create }),
}))

const setSelectedGuild = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: { setSelectedGuild: typeof setSelectedGuild }) => T): T =>
    selector({ setSelectedGuild }),
}))

const charactersRef: { current: Character[] } = { current: [] }
const teamsRef: { current: Team[] } = { current: [] }
const workflowsRef: { current: WorkflowRow[] } = { current: [] }
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(query: () => Promise<T> | T, _d: unknown[], _i: T): T => {
    const src = query.toString()
    if (src.includes("listCharacters")) return charactersRef.current as unknown as T
    if (src.includes("listTeams")) return teamsRef.current as unknown as T
    if (src.includes("listWorkflows")) return workflowsRef.current as unknown as T
    return _i
  },
}))

jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn() }))
jest.mock("@/lib/db/teams", () => ({ listTeams: jest.fn() }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn() }))

jest.mock("@/components/desktop/avatar-badge", () => ({
  // Render no text so the item's own label is the only occurrence of the name.
  AvatarBadge: () => <span data-testid="avatar" />,
}))

import { MobileCommandPalette } from "./mobile-command-palette"

function renderPalette(extra?: Partial<React.ComponentProps<typeof MobileCommandPalette>>) {
  const props = {
    open: true,
    onOpenChange: jest.fn(),
    onNewChat: jest.fn(),
    onSelectSession: jest.fn(),
    onOpenSettings: jest.fn(),
    ...extra,
  }
  render(<MobileCommandPalette {...props} />)
  return props
}

beforeEach(() => {
  push.mockReset()
  select.mockReset()
  create.mockReset().mockResolvedValue({ id: "new-s", title: "" })
  setSelectedGuild.mockReset()
  sessionsRef.current = []
  charactersRef.current = []
  teamsRef.current = []
  workflowsRef.current = []
})

describe("MobileCommandPalette", () => {
  it("renders the action group when open", async () => {
    renderPalette()
    await waitFor(() => expect(screen.getByText("actions.newChat")).toBeInTheDocument())
    expect(screen.getByText("actions.openSettings")).toBeInTheDocument()
  })

  it("new chat fires onNewChat and closes", async () => {
    const user = userEvent.setup()
    const props = renderPalette()
    await user.click(screen.getByText("actions.newChat"))
    expect(props.onNewChat).toHaveBeenCalled()
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("open settings fires onOpenSettings", async () => {
    const user = userEvent.setup()
    const props = renderPalette()
    await user.click(screen.getByText("actions.openSettings"))
    expect(props.onOpenSettings).toHaveBeenCalled()
  })

  it("jumps to a workflow route", async () => {
    workflowsRef.current = [{ id: "wf-1", name: "Nightly" } as WorkflowRow]
    const user = userEvent.setup()
    renderPalette()
    await user.click(screen.getByText("Nightly"))
    expect(push).toHaveBeenCalledWith("/workflows/editor?id=wf-1")
  })

  it("starts a chat with a character", async () => {
    charactersRef.current = [{ id: "c-1", name: "Ada" } as Character]
    const user = userEvent.setup()
    renderPalette()
    await user.click(screen.getByText("Ada"))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  })

  it("switches to a team guild", async () => {
    teamsRef.current = [{ id: "t-1", name: "Squad" } as Team]
    const user = userEvent.setup()
    renderPalette()
    await user.click(screen.getByText("Squad"))
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
  })

  it("resumes a session", async () => {
    sessionsRef.current = [{ id: "s-1", title: "Yesterday", kind: "direct" } as ChatSession]
    const user = userEvent.setup()
    const props = renderPalette()
    await user.click(screen.getByText("Yesterday"))
    expect(props.onSelectSession).toHaveBeenCalledWith("s-1")
  })
})
