// Coverage for chat-header after the data-hooks refactor — verifies that the
// header reads presets / character / skills via DataAdapter and that the
// settings popover's Save button calls `updateSession` through the adapter.

// `@tauri-apps/plugin-dialog`'s `open()` is only meaningful inside Tauri; the
// header's working-dir picker calls it conditionally on `isTauri()`. Stubbed
// so the import resolves under jsdom.
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(async () => null),
}))

// The header reads credential status (api key OR subscription bearer) + the
// active subscription tier through `useCredentialStatus`. Mock it so the
// No-API-key / tier badge cases are driven directly; the hook's own probe
// logic is covered in use-credential-status.test.ts.
jest.mock("@/hooks/chat/use-credential-status", () => ({
  useCredentialStatus: jest.fn(() => ({ keyOk: true, plan: null })),
}))

// closeSession is a Tauri IPC call the header imports for its close button.
jest.mock("@/lib/claude/ipc", () => ({
  closeSession: jest.fn(async () => undefined),
}))

// The clear-conversation trigger pulls in the chat store + data adapter; the
// header's logic tests don't need its internals (it has its own suite).
jest.mock("@/components/chat/dialogs/clear-conversation-trigger", () => ({
  ClearConversationTrigger: () => null,
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

// The header now hosts the conversation-list (ChannelList) collapse toggle.
// Mock the ui-store so the collapsed state + toggle are driven directly (the
// header's children don't touch this store, so a minimal mock is safe). Read
// lazily inside the selector so the module init order stays TDZ-safe.
let sidebarCollapsed = false
const toggleSidebar = jest.fn(() => {
  sidebarCollapsed = !sidebarCollapsed
})
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: Record<string, unknown>) => T): T =>
    selector({ sidebarCollapsed, toggleSidebar }),
}))

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { ReactNode } from "react"
import { ChatHeader } from "./chat-header"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { isTauri } from "@/lib/tauri"

const mockCredentialStatus = useCredentialStatus as unknown as jest.Mock
const mockIsTauri = isTauri as unknown as jest.Mock
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import { CHROME_BUDGET, countControls } from "@/lib/ui/chrome-budget"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { ChatSession, Character, SystemPromptPreset, Skill } from "@cognia/agent-config-types"

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
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: null })
    sidebarCollapsed = false
    toggleSidebar.mockClear()
  })

  // `sidebarCollapsed` used to have four entry points on one screen — this
  // header, two inside the title bar's layout controls, and the status bar.
  // The header is not one of them any more; Views / the native View menu / ⌘B
  // are.
  it("no longer carries a conversation-list toggle", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(screen.queryByTestId("chat-sidebar-toggle")).not.toBeInTheDocument()
    expect(toggleSidebar).not.toHaveBeenCalled()
  })

  it("keeps the right artifacts-dock toggle", () => {
    act(() => useArtifactDockLayoutStore.setState({ dockCollapsed: true }))
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    const toggle = screen.getByTestId("chat-artifact-dock-toggle")
    expect(toggle).toHaveAttribute("aria-label", "Show artifacts panel")
    expect(toggle).toHaveAttribute("aria-pressed", "false")
  })

  it("clicking the artifacts-dock toggle drives the dock collapse action", () => {
    act(() => useArtifactDockLayoutStore.setState({ dockCollapsed: true }))
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    fireEvent.click(screen.getByTestId("chat-artifact-dock-toggle"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  it("shows a compact exit action only for the secondary split pane", () => {
    const onExitSplit = jest.fn()
    const Wrapper = withAdapter(makeAdapter())
    const { rerender } = render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(screen.queryByRole("button", { name: /exit split view/i })).not.toBeInTheDocument()

    rerender(
      <Wrapper>
        <ChatHeader session={mkSession()} onExitSplit={onExitSplit} />
      </Wrapper>
    )
    fireEvent.click(screen.getByRole("button", { name: /exit split view/i }))
    expect(onExitSplit).toHaveBeenCalledTimes(1)
  })

  it("shows a compact split action when another conversation is open", () => {
    const onSplitView = jest.fn()
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} onSplitView={onSplitView} />
      </Wrapper>
    )
    fireEvent.click(screen.getByRole("button", { name: /^split view$/i }))
    expect(onSplitView).toHaveBeenCalledTimes(1)
  })

  it("shows an unread dot + hint when an artifact arrived while the dock is dismissed", () => {
    act(() => useArtifactDockLayoutStore.setState({ dockCollapsed: true, unreadArtifact: true }))
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(screen.getByTestId("chat-artifact-dock-unread")).toBeInTheDocument()
    expect(screen.getByTestId("chat-artifact-dock-toggle")).toHaveAttribute(
      "aria-label",
      "New artifacts — open panel"
    )
  })

  it("hides the unread dot once the dock is open", () => {
    act(() => useArtifactDockLayoutStore.setState({ dockCollapsed: false, unreadArtifact: true }))
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(screen.queryByTestId("chat-artifact-dock-unread")).not.toBeInTheDocument()
  })

  // Three buttons left the header for surfaces that already owned their
  // concern. Their behaviour is covered where they landed:
  //   browser opener  → title-bar-layout-controls.test.tsx (Views menu)
  //   agent-flow      → session-settings-sheet.test.tsx (already had a copy)
  //   insights        → session-settings-sheet.test.tsx (new row)
  it("no longer carries the browser, agent-flow or insights buttons", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(screen.queryByTestId("chat-browser-dock-open")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-flow-display-toggle")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /insights/i })).not.toBeInTheDocument()
  })

  it("shows the No-API-key badge when neither api key nor subscription bearer exists", async () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(await screen.findByText(/no api key/i)).toBeInTheDocument()
  })

  it("hides the No-API-key badge when a subscription OAuth bearer is active", () => {
    // Subscription-reuse users have no ANTHROPIC_API_KEY — auth flows through
    // the OAuth bearer pushed by `subscription_set_active`. The badge must
    // treat that as configured.
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: null })
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(screen.queryByText(/no api key/i)).not.toBeInTheDocument()
  })

  // The subscription tier badge and the skills badge moved into
  // SessionSettingsSheet (control-surface consolidation); their coverage now
  // lives in session-settings-sheet.test.tsx.

  it("renders the session title (no character)", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession({ title: "My Chat" })} />
      </Wrapper>
    )
    expect(screen.getByText("My Chat")).toBeInTheDocument()
  })

  it("keeps the character on one line, as the title's tooltip", () => {
    // The name + description used to be a permanent second row. The avatar
    // already signals which character is bound; the words are on hover now.
    const c = mkCharacter({ id: "c-zed", name: "Zed", description: "the helper" })
    const adapter = makeAdapter({ useCharacter: () => c })
    render(
      <DataAdapterProvider adapter={adapter}>
        <ChatHeader session={mkSession({ characterId: "c-zed", title: "T" })} />
      </DataAdapterProvider>
    )
    const title = screen.getByText("T")
    expect(title).toBeInTheDocument()
    expect(title).toHaveAttribute("title", "T — Zed · the helper")
    // No second text row.
    expect(screen.queryByText(/the helper/)).not.toBeInTheDocument()
  })

  it("falls back to the character name alone when it has no description", () => {
    const c = mkCharacter({ id: "c-zed", name: "Zed", description: undefined })
    const adapter = makeAdapter({ useCharacter: () => c })
    render(
      <DataAdapterProvider adapter={adapter}>
        <ChatHeader session={mkSession({ characterId: "c-zed", title: "T" })} />
      </DataAdapterProvider>
    )
    expect(screen.getByText("T")).toHaveAttribute("title", "T — Zed")
  })

  it("uses the bare session title when no character is bound", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ChatHeader session={mkSession({ title: "T" })} />
      </Wrapper>
    )
    expect(screen.getByText("T")).toHaveAttribute("title", "T")
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

  it("stays within the chat-header chrome control budget", () => {
    // Plain direct session, no character, credentials fine — the header a user
    // sees for most of the day. Ratchet, not a target (lib/ui/chrome-budget.ts).
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <ChatHeader session={mkSession()} />
      </Wrapper>
    )
    expect(countControls(container.querySelector("header"))).toBeLessThanOrEqual(
      CHROME_BUDGET.chatHeader
    )
  })
})
