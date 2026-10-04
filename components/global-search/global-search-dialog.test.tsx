/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { makeTestContext } from "@/lib/global-search/testing"
import type { GlobalSearchGroup, GlobalSearchOutcome } from "@/lib/global-search/types"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"

const searchState: {
  outcome: GlobalSearchOutcome | null
  suggestions: GlobalSearchGroup[]
  loading: boolean
  error: Error | null
} = { outcome: null, suggestions: [], loading: false, error: null }
const useGlobalSearchSpy = jest.fn()
const runItem = jest.fn()
const runStoredAction = jest.fn()
const shortcutHandlers = new Map<string, (event: KeyboardEvent) => void>()
const platformRef = { current: "tauri" as string }
const invalidateCaches = jest.fn()
const recordRecentQuery = jest.fn()
const trackEvent = jest.fn(async () => true)

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ relativeTime: () => "rel", dateTime: () => "abs" }),
  useNow: () => new Date(1_750_000_000_000),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...(args as [])),
}))
jest.mock("@cognia/logging", () => ({
  loggers: { ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))
const useSessionsMock = jest.fn()
jest.mock("@/hooks/chat", () => ({
  useSessions: (opts?: unknown) => {
    useSessionsMock(opts)
    return { sessions: [], select: jest.fn(), create: jest.fn() }
  },
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platformRef.current }))
const pointerRef = { coarse: false }
jest.mock("@/hooks/ui/use-pointer", () => ({
  useCoarsePointer: () => pointerRef.coarse,
  useHasHover: () => !pointerRef.coarse,
  useShowKeyboardHints: () => !pointerRef.coarse,
}))
const keyboardRef = { keyboardHeight: 0, isVisible: false }
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardInsets: () => keyboardRef,
}))
jest.mock("@/hooks/shortcuts/use-app-shortcut", () => ({
  useAppShortcut: (id: string, handler: (event: KeyboardEvent) => void) => {
    shortcutHandlers.set(id, handler)
  },
}))
jest.mock("@/hooks/global-search/use-global-search-context", () => ({
  useGlobalSearchContext: ({ scope }: { scope: string }) => ({ ...makeTestContext(), scope }),
}))
jest.mock("@/hooks/global-search/use-global-search", () => ({
  useGlobalSearch: (opts: unknown) => {
    useGlobalSearchSpy(opts)
    const { rawQuery } = opts as { rawQuery: string }
    // The real hook parses; mirror just enough for the dialog's branches.
    const { parseGlobalSearchQuery } = jest.requireActual("@/lib/global-search/query-parser")
    return {
      parsed: parseGlobalSearchQuery(rawQuery),
      outcome: searchState.outcome,
      suggestions: searchState.suggestions,
      loading: searchState.loading,
      error: searchState.error,
      refresh: jest.fn(),
    }
  },
}))
jest.mock("@/hooks/global-search/use-global-search-actions", () => ({
  useGlobalSearchActions: () => ({ runItem, runStoredAction }),
}))
jest.mock("@/lib/global-search/cache", () => ({
  invalidateGlobalSearchCaches: () => invalidateCaches(),
}))
jest.mock("@/lib/global-search/recents", () => ({
  ...jest.requireActual("@/lib/global-search/recents"),
  recordRecentQuery: (...a: unknown[]) => recordRecentQuery(...a),
}))

import {
  GlobalSearchDialog,
  isListNavigationKey,
  stopTouchPointerSelection,
} from "./global-search-dialog"

const group = (over: Partial<GlobalSearchGroup> = {}): GlobalSearchGroup => ({
  kind: "session",
  providerId: "builtin.sessions",
  items: [
    {
      id: "session:1",
      kind: "session",
      title: "Deploy notes",
      score: 1,
      action: { type: "open-session", sessionId: "1" },
    },
  ],
  bestScore: 1,
  total: 1,
  truncated: false,
  coverage: "complete",
  ...over,
})

const outcome = (
  groups: GlobalSearchGroup[],
  over: Partial<GlobalSearchOutcome> = {}
): GlobalSearchOutcome => ({
  groups,
  totalHits: groups.reduce((n, g) => n + g.total, 0),
  coverage: "complete",
  tookMs: 3,
  aborted: false,
  ...over,
})

const host = { onOpenSettings: jest.fn() }

function renderDialog(props: Partial<React.ComponentProps<typeof GlobalSearchDialog>> = {}) {
  return render(
    <TooltipProvider>
      <GlobalSearchDialog host={host} {...props} />
    </TooltipProvider>
  )
}

const lastSearchOptions = () =>
  useGlobalSearchSpy.mock.calls[useGlobalSearchSpy.mock.calls.length - 1]![0] as {
    rawQuery: string
    enabled: boolean
    limit?: number
    ctx: { scope: string }
  }

beforeEach(() => {
  jest.clearAllMocks()
  shortcutHandlers.clear()
  searchState.outcome = null
  searchState.suggestions = []
  searchState.loading = false
  searchState.error = null
  platformRef.current = "tauri"
  pointerRef.coarse = false
  keyboardRef.keyboardHeight = 0
  keyboardRef.isVisible = false
})

describe("GlobalSearchDialog", () => {
  it("stays closed until requested, then opens seeded with query and scope", async () => {
    renderDialog()
    expect(screen.queryByTestId("global-search-dialog")).toBeNull()
    expect(lastSearchOptions().enabled).toBe(false)
    act(() => requestCommandPalette({ query: "in:settings theme", scope: "pages" }))
    const input = await screen.findByTestId("global-search-input")
    expect(input).toHaveValue("in:settings theme")
    expect(invalidateCaches).toHaveBeenCalled()
    // `seeded` records only that a query was pre-filled — never its text.
    expect(trackEvent).toHaveBeenCalledWith("app.search.opened", {
      via: "request",
      scope: "pages",
      seeded: true,
    })
    expect(screen.getByRole("tab", { name: /scopes.pages/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(lastSearchOptions()).toMatchObject({ enabled: true, rawQuery: "in:settings theme" })
    expect(lastSearchOptions().ctx.scope).toBe("pages")
    // The recognised filter shows as a chip.
    expect(screen.getByTestId("global-search-filter-chip")).toHaveTextContent(
      "filters.in: settings"
    )
  })

  it("registers the rebindable shortcut and toggles with it", async () => {
    renderDialog()
    // Re-read the handler after each render: the mock stores the latest closure.
    const toggle = () =>
      shortcutHandlers.get("app.commandPalette.toggle")!(new KeyboardEvent("keydown"))
    expect(shortcutHandlers.has("app.commandPalette.toggle")).toBe(true)
    act(() => toggle())
    expect(await screen.findByTestId("global-search-dialog")).toBeInTheDocument()
    expect(trackEvent).toHaveBeenCalledWith("app.search.opened", {
      via: "shortcut",
      scope: "all",
      seeded: false,
    })
    act(() => toggle())
    await waitFor(() => expect(screen.queryByTestId("global-search-dialog")).toBeNull())
  })

  it("renders groups, records the query on select, and offers show-all / show-more", async () => {
    const user = userEvent.setup()
    searchState.outcome = outcome([
      group({ truncated: true, total: 9 }),
      group({
        kind: "message",
        providerId: "builtin.messages",
        items: [
          {
            id: "message:m",
            kind: "message",
            title: "Deploy notes",
            subtitle: "snippet",
            score: 0.5,
            action: { type: "open-session", sessionId: "1", messageId: "m" },
          },
        ],
        error: undefined,
      }),
      group({ kind: "skill", providerId: "builtin.skills", items: [], error: "dexie down" }),
    ])
    renderDialog()
    act(() => requestCommandPalette({ query: "deploy" }))
    await screen.findByTestId("global-search-dialog")
    expect(screen.getByTestId("global-search-group-session")).toBeInTheDocument()
    expect(screen.getByText("kinds.message")).toBeInTheDocument()
    expect(screen.getByText('error:{"message":"dexie down"}')).toBeInTheDocument()
    expect(screen.getByTestId("global-search-result-count")).toHaveTextContent(
      'footer.results:{"count":11}'
    )
    // Tab counts derive from the outcome in the All scope.
    expect(screen.getByRole("tab", { name: /scopes.chats 10/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /scopes.messages 1/ })).toBeInTheDocument()

    await user.click(screen.getAllByTestId("global-search-row")[0]!)
    expect(recordRecentQuery).toHaveBeenCalledWith("deploy")
    expect(runItem).toHaveBeenCalledWith(expect.objectContaining({ id: "session:1" }))

    // "Show all N in Chats" switches the scope; a scoped truncated group offers "show more".
    await user.click(screen.getByTestId("global-search-show-all-session"))
    expect(screen.getByRole("tab", { name: /scopes.chats/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(lastSearchOptions().ctx.scope).toBe("chats")
    // In the chats scope the message group heading names the query.
    expect(screen.getByText('groups.messagesInChats:{"query":"deploy"}')).toBeInTheDocument()
    await user.click(screen.getByTestId("global-search-show-more-session"))
    expect(lastSearchOptions().limit).toBe(60)
    expect(screen.queryByTestId("global-search-show-all-session")).toBeNull()
  })

  it("cycles scopes with Tab / Shift+Tab / Alt+digit and pops chips with Backspace", async () => {
    renderDialog()
    act(() => requestCommandPalette({ query: "from:me " }))
    const input = await screen.findByTestId("global-search-input")
    fireEvent.keyDown(input, { key: "Tab" })
    expect(screen.getByRole("tab", { name: /scopes.chats/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true })
    expect(screen.getByRole("tab", { name: /scopes.all/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(input, { key: "4", altKey: true })
    expect(screen.getByRole("tab", { name: /scopes.commands/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.keyDown(input, { key: "9", altKey: true })
    expect(screen.getByRole("tab", { name: /scopes.commands/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    // Only a chip remains → Backspace (caret at the end) drops it whole.
    expect(screen.getByTestId("global-search-filter-chip")).toBeInTheDocument()
    ;(input as HTMLInputElement).setSelectionRange(3, 3)
    fireEvent.keyDown(input, { key: "Backspace" })
    expect(screen.getByTestId("global-search-filter-chip")).toBeInTheDocument()
    ;(input as HTMLInputElement).setSelectionRange(8, 8)
    fireEvent.keyDown(input, { key: "Backspace" })
    await waitFor(() => expect(screen.queryByTestId("global-search-filter-chip")).toBeNull())
    expect(input).toHaveValue("")
    // Clicking a chip's × does the same through the parser.
    fireEvent.change(input, { target: { value: "is:archived x" } })
    await screen.findByTestId("global-search-filter-chip")
    await userEvent.setup().click(screen.getByRole("button", { name: /filters.remove/ }))
    expect(input).toHaveValue("x")
  })

  it("shows the empty state for a blank query and the no-results / error states", async () => {
    searchState.suggestions = [
      group({
        kind: "action",
        providerId: "builtin.actions",
        items: [
          {
            id: "action:new",
            kind: "action",
            title: "New",
            score: 1,
            action: { type: "command", id: "new-chat" },
          },
        ],
      }),
    ]
    renderDialog()
    act(() => requestCommandPalette({}))
    await screen.findByTestId("global-search-dialog")
    expect(screen.getByText("kinds.action")).toBeInTheDocument()
    expect(screen.getByTestId("global-search-input")).toHaveAttribute("placeholder", "placeholder")

    searchState.outcome = outcome([])
    const input = screen.getByTestId("global-search-input")
    fireEvent.change(input, { target: { value: "zzz" } })
    expect(await screen.findByTestId("global-search-empty")).toHaveTextContent(
      'empty:{"query":"zzz"}'
    )
    // Filters without words get a nudge instead of "no results for ''".
    fireEvent.change(input, { target: { value: "from:me " } })
    expect(await screen.findByTestId("global-search-empty")).toHaveTextContent("emptyFilters")

    searchState.error = new Error("kaput")
    fireEvent.change(input, { target: { value: "zzzz" } })
    expect(await screen.findByRole("alert")).toHaveTextContent('error:{"message":"kaput"}')
  })

  it("refills a recent query and replays a recently opened item from the empty state", async () => {
    const recents = jest.requireActual("@/lib/global-search/recents")
    window.localStorage.clear()
    recents.recordRecentQuery("deploy notes")
    recents.recordRecentItem({
      id: "workflow:w1",
      kind: "workflow",
      title: "Release train",
      score: 1,
      action: { type: "navigate", href: "/workflows/editor?id=w1" },
    })
    renderDialog()
    act(() => requestCommandPalette({}))
    await screen.findByTestId("global-search-dialog")
    const user = userEvent.setup()
    // A recently opened item replays its stored action…
    await user.click(screen.getByText("Release train"))
    expect(runStoredAction).toHaveBeenCalledWith({
      type: "navigate",
      href: "/workflows/editor?id=w1",
    })
    // …and a recent query chip refills the input (which then leaves the empty
    // state, so this has to come last).
    const chips = screen.getByTestId("global-search-recent-queries")
    await user.click(within(chips).getByRole("button", { name: "deploy notes" }))
    expect(screen.getByTestId("global-search-input")).toHaveValue("deploy notes")
    expect(screen.queryByTestId("global-search-recent-queries")).toBeNull()
    window.localStorage.clear()
  })

  it("supports controlled open, mobile layout, and closing via Escape", async () => {
    platformRef.current = "mobile"
    const onOpenChange = jest.fn()
    const { rerender } = renderDialog({ open: false, onOpenChange })
    expect(screen.queryByTestId("global-search-dialog")).toBeNull()
    rerender(
      <TooltipProvider>
        <GlobalSearchDialog host={host} open onOpenChange={onOpenChange} />
      </TooltipProvider>
    )
    const dialog = await screen.findByTestId("global-search-dialog")
    expect(dialog.className).toContain("h-[100dvh]")
    expect(invalidateCaches).toHaveBeenCalled()
    // A controlled open lands on All; the scope tabs still switch the placeholder.
    expect(screen.getByRole("tab", { name: /scopes.all/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "Tab" })
    expect(screen.getByRole("tab", { name: /scopes.chats/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByTestId("global-search-input")).toHaveAttribute(
      "placeholder",
      "placeholders.chats"
    )
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "Escape" })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})

describe("session list gating", () => {
  // The dialog is mounted unconditionally by the desktop shell, and its
  // cross-workspace live query reads every FULL session row (`branchSeed
  // .content` included) on every `sessions` write — which during a streaming
  // turn is once per persisted chunk. The engine was already gated on `open`;
  // the list feeding it has to be too.
  it("does not run the session live query while closed", () => {
    useSessionsMock.mockClear()
    renderDialog({ open: false })
    expect(useSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ crossWorkspace: true, enabled: false })
    )
  })

  it("runs it once open", () => {
    useSessionsMock.mockClear()
    renderDialog({ open: true })
    expect(useSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ crossWorkspace: true, enabled: true })
    )
  })
})

describe("referencing from the palette", () => {
  // ⌘K could already FIND a message in another conversation; the only thing a
  // hit could do was navigate, so you searched for the thing you wanted to
  // reuse and then had to find it again from the `@` panel.
  const messageGroup = () =>
    group({
      kind: "message",
      providerId: "builtin.messages",
      items: [
        {
          id: "message:m1",
          kind: "message",
          title: "Restacking",
          score: 1,
          extra: { sessionId: "s1" },
          action: { type: "open-session", sessionId: "s1", messageId: "m1" },
        },
      ],
    })

  /** A workflow is a thing you RUN — the registry's line for "not referenceable". */
  const workflowGroup = () =>
    group({
      kind: "workflow",
      providerId: "builtin.library",
      items: [
        {
          id: "workflow:w1",
          kind: "workflow",
          title: "Nightly sync",
          score: 1,
          action: { type: "navigate", href: "/workflows" },
        },
      ],
    })

  /** Open with a query, which is what makes the dialog render groups. */
  async function openWithResults(groups = [messageGroup()]) {
    searchState.outcome = outcome(groups)
    renderDialog()
    act(() => requestCommandPalette({ query: "restack" }))
    await screen.findByTestId("global-search-dialog")
  }

  it("stages the row instead of opening it", async () => {
    await openWithResults()
    await userEvent.click(screen.getByTestId("global-search-reference"))
    await waitFor(() => expect(runItem).toHaveBeenCalled())
    // The trailing click must not ALSO open the row.
    expect(runItem).toHaveBeenCalledTimes(1)
    expect(runItem.mock.calls[0]![0].action).toMatchObject({
      type: "reference-in-composer",
      candidate: { entityKind: "message", id: "s1#m1" },
    })
  })

  it("references the highlighted row on Cmd+Enter", async () => {
    await openWithResults()
    screen.getByTestId("global-search-row").setAttribute("data-selected", "true")
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "Enter", metaKey: true })
    await waitFor(() => expect(runItem).toHaveBeenCalled())
    expect(runItem.mock.calls[0]![0].action.type).toBe("reference-in-composer")
  })

  it("leaves a plain Enter meaning open", async () => {
    await openWithResults()
    screen.getByTestId("global-search-row").setAttribute("data-selected", "true")
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "Enter" })
    expect(runItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ type: "reference-in-composer" }),
      })
    )
  })

  // A modifier that means "reference" on some rows and "open" on others is
  // worse than one that does nothing on the rest.
  it("does not fall through to opening on Cmd+Enter over an unreferenceable row", async () => {
    await openWithResults([workflowGroup()])
    screen.getByTestId("global-search-row").setAttribute("data-selected", "true")
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "Enter", metaKey: true })
    expect(runItem).not.toHaveBeenCalled()
  })

  // The registry's line: a workflow is a thing you RUN, not a body to read.
  it("offers no control on a row that cannot be referenced", async () => {
    await openWithResults([workflowGroup()])
    expect(screen.queryByTestId("global-search-reference")).toBeNull()
  })
})

describe("syntax help in the input row", () => {
  it("sits at the end of the input row and opens the cheat sheet without taking focus", async () => {
    renderDialog()
    act(() => requestCommandPalette({}))
    const input = await screen.findByTestId("global-search-input")
    const help = screen.getByTestId("global-search-syntax-help")
    // In the input row, after the input — not in the footer.
    const inputRow = input.closest('[data-slot="command-input-wrapper"]')!
    expect(inputRow).toContainElement(help)
    expect(input.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId("global-search-footer")).not.toContainElement(help)
    input.focus()
    await userEvent.click(help)
    const content = await screen.findByTestId("global-search-syntax-help-content")
    expect(within(content).getByText("syntax.prefixes")).toBeInTheDocument()
    expect(within(content).getByText("syntax.in")).toBeInTheDocument()
    expect(input).toHaveFocus()
  })
})

describe("phone layout", () => {
  it("draws no footer row when there is nothing to warn about", async () => {
    platformRef.current = "mobile"
    pointerRef.coarse = true
    searchState.outcome = outcome([group()])
    renderDialog({ open: true, onOpenChange: jest.fn() })
    await screen.findByTestId("global-search-dialog")
    expect(screen.queryByTestId("global-search-footer")).toBeNull()
    // The help is still one tap away, in the input row.
    expect(screen.getByTestId("global-search-syntax-help")).toBeInTheDocument()
  })

  it("keeps only the coverage warning when results are incomplete", async () => {
    platformRef.current = "mobile"
    pointerRef.coarse = true
    searchState.outcome = outcome([group()], { coverage: "partial" })
    renderDialog({ open: true, onOpenChange: jest.fn() })
    await screen.findByTestId("global-search-dialog")
    act(() => {
      fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "deploy" } })
    })
    const footer = await screen.findByTestId("global-search-footer")
    expect(within(footer).getByTestId("global-search-coverage")).toBeInTheDocument()
    expect(within(footer).queryByTestId("global-search-result-count")).toBeNull()
  })

  it("lets the list take the remaining height and lifts it above an overlapping keyboard", async () => {
    platformRef.current = "mobile"
    keyboardRef.keyboardHeight = 280
    keyboardRef.isVisible = true
    renderDialog({ open: true, onOpenChange: jest.fn() })
    const dialog = await screen.findByTestId("global-search-dialog")
    expect(dialog.style.paddingBottom).toBe("280px")
    const list = dialog.querySelector("[cmdk-list]")!
    expect(list.className).toContain("flex-1")
    expect(list.className).toContain("min-h-0")
    expect(list.className).toContain("overscroll-contain")
  })

  it("adds no keyboard padding when the WebView itself resizes (zero overlap)", async () => {
    platformRef.current = "mobile"
    keyboardRef.isVisible = true
    renderDialog({ open: true, onOpenChange: jest.fn() })
    const dialog = await screen.findByTestId("global-search-dialog")
    expect(dialog.style.paddingBottom).toBe("")
  })

  it("keeps the desktop footer with its key legend", async () => {
    renderDialog()
    act(() => requestCommandPalette({}))
    await screen.findByTestId("global-search-dialog")
    expect(screen.getByTestId("global-search-key-legend")).toBeInTheDocument()
  })
})

describe("touch does not move the highlight", () => {
  const twoRows = () =>
    group({
      items: [
        {
          id: "session:1",
          kind: "session",
          title: "First",
          score: 1,
          action: { type: "open-session", sessionId: "1" },
        },
        {
          id: "session:2",
          kind: "session",
          title: "Second",
          score: 0.9,
          action: { type: "open-session", sessionId: "2" },
        },
      ],
      total: 2,
    })

  async function openWithRows() {
    searchState.outcome = outcome([twoRows()])
    renderDialog()
    act(() => requestCommandPalette({ query: "s" }))
    await screen.findByTestId("global-search-dialog")
    return screen.getAllByTestId("global-search-row")
  }

  const pointerMove = (target: Element, pointerType: string) => {
    const event = new MouseEvent("pointermove", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "pointerType", { value: pointerType })
    fireEvent(target, event)
  }
  const pointerDown = (target: Element, pointerType: string) => {
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "pointerType", { value: pointerType })
    fireEvent(target, event)
  }

  it("ignores touch and pen pointer moves over rows, but follows the mouse", async () => {
    const rows = await openWithRows()
    expect(rows[0]).toHaveAttribute("data-selected", "true")
    pointerMove(rows[1]!, "touch")
    expect(rows[1]).toHaveAttribute("data-selected", "false")
    pointerMove(rows[1]!, "pen")
    expect(rows[1]).toHaveAttribute("data-selected", "false")
    expect(rows[0]).toHaveAttribute("data-selected", "true")
    pointerMove(rows[1]!, "mouse")
    expect(rows[1]).toHaveAttribute("data-selected", "true")
  })

  it("opens exactly the tapped row, whatever is highlighted", async () => {
    const rows = await openWithRows()
    pointerDown(rows[1]!, "touch")
    fireEvent.click(rows[1]!)
    expect(runItem).toHaveBeenCalledTimes(1)
    expect(runItem).toHaveBeenCalledWith(expect.objectContaining({ id: "session:2" }))
  })

  it("stops painting the active row after a touch, and paints it again on arrow keys", async () => {
    const rows = await openWithRows()
    const root = screen.getByTestId("global-search-dialog").querySelector("[cmdk-root]")!
    expect(root).toHaveAttribute("data-input-mode", "mouse")
    pointerDown(rows[1]!, "touch")
    expect(root).toHaveAttribute("data-input-mode", "touch")
    expect(root.className).toContain(
      "data-[input-mode=touch]:[&_[cmdk-item][data-selected=true]]:bg-transparent"
    )
    // Soft-keyboard typing does not count as list navigation…
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "Unidentified" })
    expect(root).toHaveAttribute("data-input-mode", "touch")
    // …arrow keys do.
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "ArrowDown" })
    expect(root).toHaveAttribute("data-input-mode", "keyboard")
    expect(rows[1]).toHaveAttribute("data-selected", "true")
    // A mouse moving over the list hands the highlight back to hover.
    pointerMove(rows[0]!, "mouse")
    expect(root).toHaveAttribute("data-input-mode", "mouse")
  })

  it("starts in touch mode on a coarse primary pointer", async () => {
    pointerRef.coarse = true
    await openWithRows()
    const root = screen.getByTestId("global-search-dialog").querySelector("[cmdk-root]")!
    expect(root).toHaveAttribute("data-input-mode", "touch")
  })
})

describe("isListNavigationKey", () => {
  const key = (
    k: string,
    mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}
  ) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  })

  it("accepts arrows, Home/End and cmdk's Ctrl vim chords", () => {
    for (const k of ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) {
      expect(isListNavigationKey(key(k))).toBe(true)
    }
    expect(isListNavigationKey(key("n", { ctrlKey: true }))).toBe(true)
    expect(isListNavigationKey(key("k", { ctrlKey: true }))).toBe(true)
  })

  it("rejects typing, soft-keyboard keys and other chords", () => {
    expect(isListNavigationKey(key("n"))).toBe(false)
    expect(isListNavigationKey(key("Unidentified"))).toBe(false)
    expect(isListNavigationKey(key("Enter"))).toBe(false)
    expect(isListNavigationKey(key("k", { ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isListNavigationKey(key("x", { ctrlKey: true }))).toBe(false)
  })
})

describe("stopTouchPointerSelection", () => {
  const event = (pointerType: string) => ({ pointerType, stopPropagation: jest.fn() })

  it("stops non-mouse moves and lets mouse moves through", () => {
    for (const type of ["touch", "pen"]) {
      const e = event(type)
      stopTouchPointerSelection(e as never)
      expect(e.stopPropagation).toHaveBeenCalled()
    }
    const mouse = event("mouse")
    stopTouchPointerSelection(mouse as never)
    expect(mouse.stopPropagation).not.toHaveBeenCalled()
  })
})
