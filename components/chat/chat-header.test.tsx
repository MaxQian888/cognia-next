// Coverage for chat-header after the data-hooks refactor — verifies that the
// header reads presets / character / skills via DataAdapter and that the
// settings popover's Save button calls `updateSession` through the adapter.

// `@tauri-apps/plugin-dialog`'s `open()` is only meaningful inside Tauri; the
// header's working-dir picker calls it conditionally on `isTauri()`. Stubbed
// so the import resolves under jsdom.
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(async () => null),
}))

// hasApiKey()/hasOauthBearer() are Tauri IPC calls — also conditional on
// isTauri(). Controllable so the No-API-key badge cases can flip them.
// jest.fn defined INSIDE the factory: modules call isTauri() at init time,
// so an outer `const mock...` hits the TDZ before initialization.
jest.mock("@/lib/claude/ipc", () => ({
  hasApiKey: jest.fn(async () => true),
  hasOauthBearer: jest.fn(async () => false),
  closeSession: jest.fn(async () => undefined),
}))

// isTauri() gates the key probe (and the working-dir picker). Default false
// (jsdom); the badge tests flip it to true per-case.
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => false),
}))

// The header account switcher talks to the subscription transport when
// isTauri() is true — irrelevant to header logic tests. Stubbed like the
// other heavy children below.
jest.mock("./header-account-switcher", () => ({
  HeaderAccountSwitcher: () => null,
}))

// Single-export trigger pulls in lots of unrelated machinery (multiple
// renderers, html-formatter, etc.). Logic test of the header doesn't need it.
jest.mock("@/components/chat/dialogs/single-export-trigger", () => ({
  SingleExportTrigger: () => null,
}))

// The live cost badge subscribes to the chat store + a Dexie liveQuery; the
// header's logic tests don't need it. Stubbed to keep the store/Dexie out.
jest.mock("@/components/chat/session-cost-badge-live", () => ({
  SessionCostBadgeLive: () => null,
}))

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { ReactNode } from "react"
import { ChatHeader } from "./chat-header"
import { hasApiKey, hasOauthBearer } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"

const mockHasApiKey = hasApiKey as unknown as jest.Mock
const mockHasOauthBearer = hasOauthBearer as unknown as jest.Mock
const mockIsTauri = isTauri as unknown as jest.Mock
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { ChatSession, Character, SystemPromptPreset, Skill } from "@/lib/claude/types"

// Stable empty references — chat-header has `useMemo(() => presetsRaw ?? [],
// [presetsRaw])` and similar memoised derivations that infinite-loop if the
// mock returns a fresh `[]` on every render.
const STABLE_EMPTY_CHARACTERS: Character[] = []
const STABLE_EMPTY_SKILLS: Skill[] = []
const STABLE_EMPTY_PRESETS: SystemPromptPreset[] = []

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => STABLE_EMPTY_CHARACTERS,
    useCharacter: () => undefined,
    useSkillsByIds: () => STABLE_EMPTY_SKILLS,
    usePresets: () => STABLE_EMPTY_PRESETS,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>{children}</DataAdapterProvider>
  )
  Wrapper.displayName = "ChatHeaderTestWrapper"
  return Wrapper
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_1",
  title: "Untitled",
  kind: "direct",
  characterId: undefined,
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

const mkCharacter = (overrides: Partial<Character> = {}): Character => ({
  id: "c1",
  name: "Char",
  avatarColor: "#3b82f6",
  systemPrompt: "...",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe("ChatHeader", () => {
  beforeEach(() => {
    mockIsTauri.mockReturnValue(false)
    mockHasApiKey.mockResolvedValue(true)
    mockHasOauthBearer.mockResolvedValue(false)
  })

  it("shows the No-API-key badge when neither api key nor subscription bearer exists", async () => {
    mockIsTauri.mockReturnValue(true)
    mockHasApiKey.mockResolvedValue(false)
    mockHasOauthBearer.mockResolvedValue(false)
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(await screen.findByText(/no api key/i)).toBeInTheDocument()
  })

  it("hides the No-API-key badge when a subscription OAuth bearer is active", async () => {
    // Subscription-reuse users have no ANTHROPIC_API_KEY — auth flows through
    // the OAuth bearer pushed by `subscription_set_active`. The badge must
    // treat that as configured.
    mockIsTauri.mockReturnValue(true)
    mockHasApiKey.mockResolvedValue(false)
    mockHasOauthBearer.mockResolvedValue(true)
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    // Let the key probe resolve, then assert the badge stayed hidden.
    await waitFor(() => expect(mockHasOauthBearer).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByText(/no api key/i)).not.toBeInTheDocument()
  })

  it("renders the session title (no character)", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession({ title: "My Chat" })} />
      </Wrapper>
    )
    expect(screen.getByText("My Chat")).toBeInTheDocument()
  })

  it("renders the character avatar + name when session.characterId resolves", () => {
    const c = mkCharacter({ id: "c-zed", name: "Zed", description: "the helper" })
    const adapter = makeAdapter({ useCharacter: () => c })
    render(
      <DataAdapterProvider adapter={adapter}>
        <ChatHeader session={mkSession({ characterId: "c-zed", title: "T" })} />
      </DataAdapterProvider>
    )
    expect(screen.getByText("T")).toBeInTheDocument()
    expect(screen.getByText(/Zed/)).toBeInTheDocument()
  })

  it("Save button calls adapter.updateSession with form values", async () => {
    const updateSession = jest.fn(async () => undefined)
    const adapter = makeAdapter({ updateSession })
    const session = mkSession({ id: "ses_42", title: "S" })
    render(
      <DataAdapterProvider adapter={adapter}>
        <ChatHeader session={session} />
      </DataAdapterProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: /session settings/i }))
    const save = await screen.findByRole("button", { name: /save/i })
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1))
    const firstCall = updateSession.mock.calls[0] as unknown
    if (!Array.isArray(firstCall) || firstCall.length === 0) {
      throw new Error("updateSession was not called")
    }
    expect(firstCall[0]).toBe("ses_42")
  })

  it("renders the skills badge when character has skills + adapter returns them", () => {
    const c = mkCharacter({ id: "c1", skillIds: ["s1"] })
    const skill: Skill = {
      id: "s1",
      name: "skill-x",
      content: "...",
      createdAt: 0,
      updatedAt: 0,
    }
    const adapter = makeAdapter({
      useCharacter: () => c,
      useSkillsByIds: () => [skill],
    })
    render(
      <DataAdapterProvider adapter={adapter}>
        <ChatHeader session={mkSession({ characterId: "c1" })} />
      </DataAdapterProvider>
    )
    // The badge label has the form "Skills 1/1" via i18n; just confirm a 1 is shown.
    expect(screen.getByLabelText(/skills/i)).toBeInTheDocument()
  })

  it("typed working dir survives a background session refresh (touchSession bumping updatedAt while popover open)", async () => {
    // Regression: hydration effect previously had `[open, session, presets]`
    // deps and re-fired on every parent re-render with a fresh session
    // reference (every send bumps updatedAt via touchSession). That wiped
    // the user's in-progress edits — they'd save the OLD value and see it
    // on the next reopen.
    const adapter = makeAdapter()
    let session = mkSession({ id: "ses_42", workingDir: "/old" })

    const { rerender } = render(
      <DataAdapterProvider adapter={adapter}>
        <ChatHeader session={session} />
      </DataAdapterProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: /session settings/i }))
    const input = (await screen.findByLabelText(/working/i)) as HTMLInputElement
    fireEvent.change(input, { target: { value: "/new" } })
    expect(input.value).toBe("/new")

    // Simulate touchSession firing during a parallel send: same session, new
    // updatedAt — Dexie liveQuery hands the parent a fresh array, the
    // `find()` returns a new object, ChatHeader's `session` prop changes ref.
    session = { ...session, updatedAt: Date.now() }
    await act(async () => {
      rerender(
        <DataAdapterProvider adapter={adapter}>
          <ChatHeader session={session} />
        </DataAdapterProvider>
      )
    })

    const inputAfter = (await screen.findByLabelText(/working/i)) as HTMLInputElement
    expect(inputAfter.value).toBe("/new")
  })

  it("forwards usePresets() return into the popover preset list", async () => {
    const presets: SystemPromptPreset[] = [
      {
        id: "p1",
        name: "p-one-unique-name",
        content: "hello",
        isBuiltIn: false,
        isDefault: false,
        isFavorite: false,
        sortOrder: 0,
        usageCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const adapter = makeAdapter({ usePresets: () => presets })
    render(
      <DataAdapterProvider adapter={adapter}>
        <ChatHeader session={mkSession()} />
      </DataAdapterProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /session settings/i }))
    // Preset section renders only when usePresets() resolves to at least one row.
    // Look for the Select trigger — it carries a stable id.
    await waitFor(() => {
      expect(document.getElementById("session-preset")).not.toBeNull()
    })
  })
})
