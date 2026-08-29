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

import { GlobalSearchDialog } from "./global-search-dialog"

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
    fireEvent.mouseDown(screen.getByTestId("global-search-reference"))
    await waitFor(() => expect(runItem).toHaveBeenCalled())
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
