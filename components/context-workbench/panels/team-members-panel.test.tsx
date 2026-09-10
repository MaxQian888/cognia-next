/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import type { Character, Team } from "@cognia/agent-config-types"

jest.mock("next-intl", () => {
  // Keys this bundle is missing. `t.has` answers false for them and `t` falls
  // back to the full key path — how a shell running an older message bundle
  // than the code behaves.
  const missing = new Set<string>()
  return {
    // Bare keys read as `<namespace>.<key>`; interpolated ones keep their
    // values so per-member labels stay distinguishable.
    useTranslations: (ns: string) => {
      const t = (key: string, values?: Record<string, unknown>) =>
        values && !missing.has(key) ? `${key}:${Object.values(values).join(",")}` : `${ns}.${key}`
      t.has = (key: string) => !missing.has(key)
      return t
    },
    __missingMessageKeys: missing,
  }
})
const missingMessageKeys = (jest.requireMock("next-intl") as { __missingMessageKeys: Set<string> })
  .__missingMessageKeys

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  usePathname: () => "/",
}))

jest.mock("@cognia/logging", () => {
  const stub = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  }
  return { loggers: new Proxy({}, { get: () => stub }), createLogger: () => stub }
})

const openCharacterChat = jest.fn(async () => ({ id: "opened" }))
jest.mock("@/lib/shell/start-guild-conversation", () => ({
  openCharacterChat: (...args: unknown[]) => openCharacterChat(...(args as [])),
}))

const requestComposerMention = jest.fn()
jest.mock("@/lib/chat/composer-mention-request", () => ({
  requestComposerMention: (name: string) => requestComposerMention(name),
}))

jest.mock("@/components/desktop/avatar-badge", () => ({
  AvatarBadge: ({ subject, statusDot }: { subject: { name: string }; statusDot?: unknown }) => (
    <span data-testid={`avatar-${subject.name}`}>{statusDot as never}</span>
  ),
}))

let team: Team | undefined
let characters: Character[]
let session: { scratchpad?: string; roomSettings?: Record<string, unknown> } | undefined
jest.mock("@/hooks/data", () => ({
  // Every query in this panel is keyed off a different loader; dispatch on
  // which one the component passed rather than on call order.
  useClientLiveQuery: (loader: () => Promise<unknown>) => {
    const source = loader.toString()
    if (source.includes("getTeam")) return team
    if (source.includes("listCharactersByIds")) return characters
    if (source.includes("getSession")) return session
    return undefined
  },
}))
jest.mock("@/lib/db/teams", () => ({ getTeam: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({ listCharactersByIds: jest.fn() }))
const updateSession = jest.fn(async () => {})
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
  updateSession: (...args: unknown[]) => updateSession(...(args as [])),
}))

let memberStatus: Record<string, string> = {}
let memberActivity: Record<string, string> = {}
let scratchpadCollapsed: Record<string, boolean> = {}
const setScratchpadCollapsed = jest.fn((id: string, value: boolean) => {
  scratchpadCollapsed = { ...scratchpadCollapsed, [id]: value }
})
const requestStopMember = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: Record<string, unknown>) => T): T =>
    selector({
      memberStatus,
      memberActivity,
      scratchpadCollapsed,
      setScratchpadCollapsed,
      requestStopMember,
    }),
}))

import { TeamMembersPanel } from "./team-members-panel"

const character = (id: string, name: string, model?: string): Character =>
  ({ id, name, model, avatarColor: "#888" }) as unknown as Character

beforeEach(() => {
  routerPush.mockClear()
  missingMessageKeys.clear()
  openCharacterChat.mockClear()
  requestComposerMention.mockClear()
  requestStopMember.mockClear()
  setScratchpadCollapsed.mockClear()
  updateSession.mockClear()
  memberStatus = {}
  memberActivity = {}
  scratchpadCollapsed = {}
  session = { scratchpad: "" }
  characters = [
    character("c-1", "Brainstorm Buddy", "claude-opus-5"),
    character("c-2", "Research Analyst"),
  ]
  team = {
    id: "t-1",
    name: "Product Squad",
    orchestration: "supervisor",
    supervisorCharacterId: "c-2",
    avatarColor: "#123456",
    members: [
      { characterId: "c-1", role: "Ideation" },
      { characterId: "c-2", modelOverride: "claude-sonnet-5" },
    ],
  } as unknown as Team
})

it("says what to do instead of rendering a blank panel outside a team session", () => {
  render(<TeamMembersPanel teamSessionId={null} teamId={null} />)
  expect(screen.getByTestId("team-members-empty-session")).toHaveTextContent(
    "desktop.memberList.noTeamSession"
  )
  expect(screen.queryByTestId("team-members-panel")).toBeNull()
})

it("heads the roster with the team's identity and how it dispatches replies", () => {
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  const panel = screen.getByTestId("team-members-panel")
  expect(panel).toHaveTextContent("Product Squad")
  // Orchestration mode — previously only readable in team settings.
  expect(panel).toHaveTextContent("settings.teams.orchestration.supervisor")
  expect(panel).toHaveTextContent("heading:2")
})

it("carries each member's role, effective model and supervisor mark", () => {
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  const first = screen.getByTestId("team-member-c-1")
  expect(first).toHaveTextContent("Brainstorm Buddy")
  expect(first).toHaveTextContent("Ideation · claude-opus-5")
  expect(first.querySelector('[aria-label="desktop.memberList.supervisor"]')).toBeNull()

  // The member override wins over the character's own model, and the leader
  // is marked — the two facts that tell members of one team apart.
  const second = screen.getByTestId("team-member-c-2")
  expect(second).toHaveTextContent("claude-sonnet-5")
  expect(second).not.toHaveTextContent("claude-opus-5")
  expect(second.querySelector('[aria-label="desktop.memberList.supervisor"]')).not.toBeNull()
})

it("falls back to the session default when no model is pinned anywhere", () => {
  team = {
    ...(team as Team),
    supervisorCharacterId: undefined,
    members: [{ characterId: "c-2" }],
  } as Team
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  expect(screen.getByTestId("team-member-c-2")).toHaveTextContent("desktop.memberList.defaultModel")
})

it("opens the member's own conversation on click and reports it to the host", async () => {
  const onNavigated = jest.fn()
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" onNavigated={onNavigated} />)

  await act(async () => {
    fireEvent.click(screen.getByLabelText("openChat:Brainstorm Buddy"))
  })
  expect(openCharacterChat).toHaveBeenCalledWith(
    expect.objectContaining({ id: "c-1" }),
    expect.objectContaining({ newChatTitle: "chatTitle:Brainstorm Buddy", pathname: "/" })
  )
  expect(onNavigated).toHaveBeenCalled()
})

// The conversation title is persisted, so an unresolved message would name the
// conversation `desktop.memberList.chatTitle` forever — including in the shell
// that later ships the message.
it("names a new conversation after the character when the title message is missing", async () => {
  missingMessageKeys.add("chatTitle")
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)

  await act(async () => {
    fireEvent.click(screen.getByLabelText("openChat:Brainstorm Buddy"))
  })
  expect(openCharacterChat).toHaveBeenCalledWith(
    expect.objectContaining({ id: "c-1" }),
    expect.objectContaining({ newChatTitle: "Brainstorm Buddy" })
  )
})

it("keeps the sheet open when opening the chat fails", async () => {
  const onNavigated = jest.fn()
  openCharacterChat.mockRejectedValueOnce(new Error("nope"))
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" onNavigated={onNavigated} />)

  await act(async () => {
    fireEvent.click(screen.getByLabelText("openChat:Research Analyst"))
  })
  expect(onNavigated).not.toHaveBeenCalled()
})

it("mentions through the seam, because the panel is not in the composer's tree", () => {
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  fireEvent.click(screen.getByTestId("team-member-mention-c-2"))
  expect(requestComposerMention).toHaveBeenCalledWith("Research Analyst")
  // Mentioning must not also navigate away from the team conversation.
  expect(openCharacterChat).not.toHaveBeenCalled()
})

it("collapses the shared notes per session and hides the editor with them", () => {
  const { rerender } = render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  expect(screen.getByLabelText("desktop.memberList.sharedNotes")).toBeInTheDocument()

  fireEvent.click(screen.getByTestId("team-members-notes-toggle"))
  expect(setScratchpadCollapsed).toHaveBeenCalledWith("s-1", true)

  rerender(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  expect(screen.queryByLabelText("desktop.memberList.sharedNotes")).toBeNull()
  expect(screen.getByTestId("team-members-notes-toggle")).toHaveAttribute("aria-expanded", "false")
})

it("shows the tool a busy member is on in place of its role line (ADR-0177 batch 2)", () => {
  memberStatus = { "s-1::c-1": "thinking" }
  memberActivity = { "s-1::c-1": "Read · runner.ts" }
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  const activity = screen.getByTestId("team-member-activity-c-1")
  expect(activity).toHaveTextContent("Read · runner.ts")
  expect(activity).toHaveAttribute("aria-label", expect.stringContaining("activityLabel"))
  // The other member keeps its role and model line.
  expect(screen.queryByTestId("team-member-activity-c-2")).toBeNull()
})

it("names a member's live status rather than leaking the raw enum", () => {
  memberStatus = { "s-1::c-1": "thinking" }
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  expect(
    screen.getByLabelText("statusLabel:desktop.memberList.status.thinking")
  ).toBeInTheDocument()
})

it("renders the empty roster message for a team with no resolvable members", () => {
  characters = []
  render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
  expect(screen.getByTestId("team-members-panel")).toHaveTextContent("desktop.memberList.empty")
})

describe("room settings (ADR-0177)", () => {
  const open = () => fireEvent.click(screen.getByTestId("room-settings-toggle"))

  it("stays folded under a one-line summary until asked", () => {
    render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
    const summary = screen.getByTestId("room-settings-summary")
    expect(summary).toHaveTextContent("replyModes.auto")
    expect(summary).toHaveTextContent("memoryOn")
    expect(screen.queryByTestId("room-instructions")).toBeNull()
    open()
    expect(screen.getByTestId("room-instructions")).toBeInTheDocument()
    expect(screen.getByTestId("room-settings-toggle")).toHaveAttribute("aria-expanded", "true")
  })

  it("stores the reply mode and explains what the chosen mode does", () => {
    render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
    open()
    const button = screen.getByTestId("room-reply-mode-mention_only")
    // Live since batch 3: no inert label, and the hint names the mode's effect.
    expect(button).not.toHaveAttribute("data-inert")
    expect(screen.getByTestId("room-settings-reply-mode-hint")).toHaveTextContent(
      "desktop.memberList.roomSettings.replyModeHints.auto"
    )
    fireEvent.click(button)
    expect(updateSession).toHaveBeenCalledWith("s-1", {
      roomSettings: { replyMode: "mention_only" },
    })
  })

  it("mirrors the memory switch onto the two flags the memory plane reads", () => {
    render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
    open()
    const toggle = screen.getByTestId("room-memory-switch")
    expect(toggle).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("desktop.memberList.roomSettings.memoryHint")).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(updateSession).toHaveBeenCalledWith("s-1", {
      roomSettings: { memory: false },
      memoryUse: false,
      memoryLearn: false,
    })
  })

  it("reads a room whose memory was switched off and shows the off copy", () => {
    session = { roomSettings: { memory: false } }
    render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
    expect(screen.getByTestId("room-settings-summary")).toHaveTextContent("memoryOff")
    open()
    expect(screen.getByTestId("room-memory-switch")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByText("desktop.memberList.roomSettings.memoryOffHint")).toBeInTheDocument()
  })

  it("persists the instructions after the typing pauses", () => {
    jest.useFakeTimers()
    try {
      render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
      open()
      fireEvent.change(screen.getByTestId("room-instructions"), {
        target: { value: "Answer in one line." },
      })
      expect(updateSession).not.toHaveBeenCalled()
      act(() => {
        jest.advanceTimersByTime(500)
      })
      expect(updateSession).toHaveBeenCalledWith("s-1", {
        roomSettings: { instructions: "Answer in one line." },
      })
      expect(screen.getByTestId("room-settings")).toHaveTextContent("charsCount:19")
    } finally {
      jest.useRealTimers()
    }
  })

  it("marks a muted member on its row and lets the section unmute it", () => {
    session = { roomSettings: { mutedMemberIds: ["c-2"], replyMode: "asleep" } }
    render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
    const badge = screen.getByTestId("team-member-muted-c-2")
    expect(badge).toHaveTextContent("desktop.memberList.roomSettings.muted")
    expect(badge).not.toHaveAttribute("data-inert")
    expect(screen.queryByTestId("team-member-muted-c-1")).toBeNull()
    open()
    expect(screen.getByTestId("room-settings-reply-mode-hint")).toHaveTextContent(
      "desktop.memberList.roomSettings.replyModeHints.asleep"
    )
    expect(screen.getByTestId("room-muted-hint")).toHaveTextContent(
      "desktop.memberList.roomSettings.mutedHint"
    )
    fireEvent.click(screen.getByTestId("room-unmute-c-2"))
    expect(updateSession).toHaveBeenCalledWith("s-1", {
      roomSettings: { mutedMemberIds: [], replyMode: "asleep" },
    })
  })

  it("mutes a member from its context menu without touching the other settings", async () => {
    session = { roomSettings: { instructions: "keep" } }
    render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
    fireEvent.contextMenu(screen.getByTestId("team-member-c-1"))
    const item = await screen.findByTestId("team-member-mute-c-1")
    expect(item).toHaveTextContent("mute:Brainstorm Buddy")
    fireEvent.click(item)
    expect(updateSession).toHaveBeenCalledWith("s-1", {
      roomSettings: { instructions: "keep", mutedMemberIds: ["c-1"] },
    })
  })

  it("says nobody is muted when the list is empty", () => {
    render(<TeamMembersPanel teamSessionId="s-1" teamId="t-1" />)
    open()
    expect(screen.getByTestId("room-muted-members")).toHaveTextContent(
      "desktop.memberList.roomSettings.noMuted"
    )
  })
})
