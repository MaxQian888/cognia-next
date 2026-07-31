/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

type Item = { id: string; source: string; sourceId: string; name: string; category: string }
type State = {
  loading: boolean
  error: string | null
  items: Item[]
  hasMore: boolean
  loadingMore: boolean
  tokenError: boolean
}
type HookShape = {
  state: State
  source: string
  view: string
  hasToken: boolean
  webBlocked: boolean
  query: string
}
const baseState = (over: Partial<State> = {}): State => ({
  loading: false,
  error: null,
  items: [],
  hasMore: false,
  loadingMore: false,
  tokenError: false,
  ...over,
})
const ref: { current: HookShape } = {
  current: {
    state: baseState({ loading: true }),
    source: "all",
    view: "search",
    hasToken: false,
    webBlocked: false,
    query: "",
  },
}
const install = jest.fn(async () => undefined)
const uninstall = jest.fn(async () => undefined)
const setQuery = jest.fn()
const setView = jest.fn()
const refresh = jest.fn(async () => undefined)
const loadMore = jest.fn(async () => undefined)
const fetchAudit = jest.fn()
const fetchFileTree = jest.fn()
const installedRef = { current: new Set<string>() }
jest.mock("@/hooks/skills", () => ({
  useSkillMarketplace: () => ({
    state: ref.current.state,
    source: ref.current.source,
    setSource: jest.fn(),
    query: ref.current.query,
    setQuery,
    view: ref.current.view,
    setView,
    hasToken: ref.current.hasToken,
    webBlocked: ref.current.webBlocked,
    curated: [],
    refresh,
    loadMore,
    installed: installedRef.current,
    installingId: null,
    install,
    uninstall,
    audit: () => undefined,
    fetchAudit,
    fileTree: () => undefined,
    fetchFileTree,
  }),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

const mobileRef = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mobileRef.current,
}))

const setUrlInstallOpen = jest.fn()
jest.mock("@/stores/skills/skills-store", () => ({
  useSkillsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ urlInstallOpen: false, setUrlInstallOpen }),
}))

// The row + detail components aren't under test here — stub them.
jest.mock("./skill-marketplace-list-item", () => ({
  SkillMarketplaceListItem: ({
    item,
    onSelect,
  }: {
    item: { name: string }
    onSelect: (item: unknown) => void
  }) => (
    <div data-testid="mp-row" onClick={() => onSelect(item)}>
      {item.name}
    </div>
  ),
}))
jest.mock("./skill-marketplace-detail-content", () => ({
  SkillMarketplaceDetailContent: ({
    item,
    onInstall,
    onUninstall,
  }: {
    item: { name: string }
    onInstall: (item: unknown) => void
    onUninstall: (item: unknown) => void
  }) => (
    <div data-testid="mp-detail-content">
      {item.name}
      <button data-testid="content-install" onClick={() => onInstall(item)}>
        install
      </button>
      <button data-testid="content-uninstall" onClick={() => onUninstall(item)}>
        uninstall
      </button>
    </div>
  ),
}))
jest.mock("./skill-marketplace-detail", () => ({
  SkillMarketplaceDetail: () => <div data-testid="mp-detail-sheet" />,
}))
jest.mock("./skill-marketplace-token-teaser", () => ({
  SkillMarketplaceTokenTeaser: () => <div data-testid="mp-token-teaser" />,
}))
jest.mock("@/components/plugins/scroll-shadow-row", () => ({
  ScrollShadowRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { SkillMarketplace } from "./skill-marketplace"

const twoItems = [
  { id: "1", source: "registry", sourceId: "a", name: "Alpha", category: "custom" },
  { id: "2", source: "registry", sourceId: "b", name: "Beta", category: "custom" },
]

function setHook(over: Partial<HookShape>) {
  ref.current = { ...ref.current, ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mobileRef.current = false
  installedRef.current = new Set<string>()
  ref.current = {
    state: baseState(),
    source: "all",
    view: "search",
    hasToken: false,
    webBlocked: false,
    query: "",
  }
})

describe("SkillMarketplace", () => {
  it("shows a loading row with the localized label", () => {
    setHook({ state: baseState({ loading: true }) })
    render(<SkillMarketplace />)
    expect(screen.getAllByText("loading").length).toBeGreaterThanOrEqual(1)
  })

  it("renders one row per item and auto-selects the first into the inline detail", () => {
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    expect(screen.getByTestId("skill-marketplace-list")).toBeInTheDocument()
    expect(screen.getAllByTestId("mp-row")).toHaveLength(2)
    expect(screen.getByTestId("mp-detail-content")).toHaveTextContent("Alpha")
    expect(screen.queryByTestId("mp-detail-sheet")).not.toBeInTheDocument()
  })

  it("shows the localized error message when loading fails", () => {
    setHook({ state: baseState({ error: "boom" }) })
    render(<SkillMarketplace />)
    expect(screen.getByText('errorLoad:{"error":"boom"}')).toBeInTheDocument()
  })

  it("token rejection renders the expired hint with a back-to-search action", () => {
    setHook({ state: baseState({ error: "expired", tokenError: true }), view: "trending" })
    render(<SkillMarketplace />)
    expect(screen.getByText("tokenExpired")).toBeInTheDocument()
    fireEvent.click(screen.getByText("views.search"))
    expect(setView).toHaveBeenCalledWith("search")
  })

  it("switches the inline detail when another row is clicked", () => {
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByText("Beta"))
    expect(screen.getByTestId("mp-detail-content")).toHaveTextContent("Beta")
  })

  it("shows the short-query search hint when there are no items", () => {
    setHook({ state: baseState() })
    render(<SkillMarketplace />)
    expect(screen.getByText("searchHint")).toBeInTheDocument()
  })

  it("shows the generic empty message for a real empty result", () => {
    setHook({ state: baseState(), query: "zz-nothing" })
    render(<SkillMarketplace />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("writes the search query and triggers refresh", () => {
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    fireEvent.change(screen.getByPlaceholderText("searchPlaceholder"), {
      target: { value: "alp" },
    })
    expect(setQuery).toHaveBeenCalledWith("alp")
    fireEvent.click(screen.getByLabelText("refresh"))
    expect(refresh).toHaveBeenCalled()
  })

  it("hides the view switcher without a token and shows it with one", () => {
    setHook({ state: baseState({ items: twoItems }) })
    const { rerender } = render(<SkillMarketplace />)
    expect(screen.queryByTestId("skill-marketplace-views")).not.toBeInTheDocument()
    setHook({ hasToken: true })
    rerender(<SkillMarketplace />)
    expect(screen.getByTestId("skill-marketplace-views")).toBeInTheDocument()
    fireEvent.click(screen.getByText("views.trending"))
    expect(setView).toHaveBeenCalledWith("trending")
  })

  it("shows the token teaser on an empty-query search without a token", () => {
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    expect(screen.getByTestId("mp-token-teaser")).toBeInTheDocument()
  })

  it("hides the teaser when a token exists or web is blocked", () => {
    setHook({ state: baseState({ items: twoItems }), hasToken: true })
    const { rerender } = render(<SkillMarketplace />)
    expect(screen.queryByTestId("mp-token-teaser")).not.toBeInTheDocument()
    setHook({ hasToken: false, webBlocked: true })
    rerender(<SkillMarketplace />)
    expect(screen.queryByTestId("mp-token-teaser")).not.toBeInTheDocument()
    expect(screen.getByTestId("skill-marketplace-web-blocked")).toBeInTheDocument()
  })

  it("renders Load more only when the view has more pages and wires loadMore", () => {
    setHook({ state: baseState({ items: twoItems, hasMore: true }), hasToken: true, view: "hot" })
    render(<SkillMarketplace />)
    const btn = screen.getByTestId("skill-marketplace-load-more")
    fireEvent.click(btn)
    expect(loadMore).toHaveBeenCalled()
  })

  it("opens the URL-install dialog from the search row", () => {
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByTestId("skill-marketplace-url-install"))
    expect(setUrlInstallOpen).toHaveBeenCalledWith(true)
  })

  it("installs the selected item and reports success", async () => {
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByTestId("content-install"))
    await waitFor(() => expect(install).toHaveBeenCalledWith(twoItems[0]))
    expect(toast.success).toHaveBeenCalled()
  })

  it("reports an error toast when installation fails", async () => {
    install.mockRejectedValueOnce(new Error("nope"))
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByTestId("content-install"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"))
  })

  it("uninstalls the selected item and reports success", async () => {
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByTestId("content-uninstall"))
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith(twoItems[0]))
    expect(toast.success).toHaveBeenCalled()
  })

  it("on mobile, selecting a row opens the Sheet instead of inline detail", () => {
    mobileRef.current = true
    setHook({ state: baseState({ items: twoItems }) })
    render(<SkillMarketplace />)
    expect(screen.queryByTestId("mp-detail-sheet")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Beta"))
    expect(screen.getByTestId("mp-detail-sheet")).toBeInTheDocument()
    expect(screen.queryByTestId("mp-detail-content")).not.toBeInTheDocument()
  })
})
