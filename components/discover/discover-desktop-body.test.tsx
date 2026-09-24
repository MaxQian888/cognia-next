/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && Object.keys(vars).length > 0) return key + ":" + JSON.stringify(vars)
    return key
  },
  useLocale: () => "en",
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode; href?: string }) => (
    <a {...props}>{children}</a>
  ),
}))

// Stand-in for the breakpoint hook inside FeaturePageShell — the desktop body
// test asserts the 3-pane desktop layout, not the mobile collapse behaviour.
jest.mock("@/hooks/ui", () => ({
  useIsMobile: () => false,
  useBreakpoint: () => "desktop",
}))

// Capture URL state in a module-level var so router updates flow back through
// useSearchParams on re-render. A small history stack makes push / replace /
// back behave like the browser's, which is what the item sheet relies on.
let currentSearch = ""
let cachedKey = ""
let cachedParams = new URLSearchParams("")
let history: string[] = [""]
let historyIndex = 0
function searchOf(href: string): string {
  const qIdx = href.indexOf("?")
  return qIdx >= 0 ? href.slice(qIdx) : ""
}
const replaceMock = jest.fn((href: string) => {
  currentSearch = searchOf(href)
  history[historyIndex] = currentSearch
})
const pushMock = jest.fn((href: string) => {
  currentSearch = searchOf(href)
  history = [...history.slice(0, historyIndex + 1), currentSearch]
  historyIndex = history.length - 1
})
const backMock = jest.fn(() => {
  if (historyIndex === 0) return
  historyIndex -= 1
  currentSearch = history[historyIndex] ?? ""
})
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: replaceMock,
    push: pushMock,
    back: backMock,
    prefetch: jest.fn(),
  }),
  usePathname: () => "/discover",
  useSearchParams: () => {
    const key = currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch
    if (key !== cachedKey) {
      cachedKey = key
      cachedParams = new URLSearchParams(key)
    }
    return cachedParams
  },
}))

// Mock useDiscoverQuery so the test doesn't need a live Dexie.
const characterFixture: Character = {
  id: "c1",
  name: "Alpha",
  description: "Test character",
  systemPrompt: "",
  avatarColor: "#abc",
  avatarEmoji: "🐙",
  isBuiltIn: false,
} as unknown as Character

jest.mock("@/hooks/discover/use-discover-query", () => ({
  useDiscoverQuery: (category: string) => ({
    items:
      category === "characters" ? [{ kind: "character", id: "c1", data: characterFixture }] : [],
    loading: false,
  }),
}))

// Inspector + dependencies invoke a few extra modules — stub the heavy ones
// so the test stays focused on layout wiring.
jest.mock("@/components/mobile/discover/character-detail-sheet", () => ({
  CharacterDetailSheet: () => null,
}))
// The inspector's skills empty-state pulls in SkillMarketplace → streamdown
// (ESM-only); stub the sheet so the suite loads in jsdom.
jest.mock("@/components/discover/skill-marketplace-sheet", () => ({
  SkillMarketplaceSheet: () => <div data-testid="stub-skill-marketplace-sheet" />,
}))
jest.mock("@/lib/db/skills", () => ({ setSkillStatus: jest.fn() }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    plugins: { update: jest.fn() },
    mcpServers: { update: jest.fn() },
  }),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
// The character detail's "Start chat" path creates sessions; not under test here.
jest.mock("@/lib/shell/start-guild-conversation", () => ({
  openCharacterChat: jest.fn(),
  startGuildConversation: jest.fn(),
}))
jest.mock("@/components/shell/use-shell-nav", () => ({
  useShellNav: () => ({ switchToTeam: jest.fn() }),
}))
// The saved landing preference; `null` keeps the For You default.
let landingPreference: string | null = null
jest.mock("@/hooks/discover/use-discover-preferences", () => ({
  useDiscoverPreferences: () => ({ preferences: { landingCategory: landingPreference } }),
}))

import { DiscoverDesktopBody } from "./discover-desktop-body"

function startAt(search: string): void {
  currentSearch = search
  history = [search]
  historyIndex = 0
}

beforeEach(() => {
  startAt("")
  cachedKey = ""
  cachedParams = new URLSearchParams("")
  landingPreference = null
  replaceMock.mockClear()
  pushMock.mockClear()
  backMock.mockClear()
})

describe("<DiscoverDesktopBody />", () => {
  it("renders the feature shell with the desktop toolbar + grid", () => {
    // The default landing is now the aggregated "foryou" home; pin to a real
    // category to assert the grid renders.
    currentSearch = "?category=characters"
    render(<DiscoverDesktopBody />)
    expect(screen.getByTestId("discover-desktop-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("discover-grid-characters")).toBeInTheDocument()
  })

  it("renders the aggregated home by default (no ?category=)", () => {
    render(<DiscoverDesktopBody />)
    // Default lands on the foryou home strips, not a category grid.
    expect(screen.queryByTestId("discover-grid-characters")).not.toBeInTheDocument()
    expect(screen.getByTestId("discover-category-foryou")).toBeInTheDocument()
  })

  it("renders the populated category sidebar groups", () => {
    render(<DiscoverDesktopBody />)
    expect(screen.getByTestId("discover-category-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("discover-group-agents")).toBeInTheDocument()
  })

  it("starts on the default category with an empty inspector", () => {
    render(<DiscoverDesktopBody />)
    expect(screen.getByTestId("discover-inspector-empty")).toBeInTheDocument()
  })

  it("clicking a sidebar entry writes ?category= to the URL", async () => {
    const user = userEvent.setup()
    render(<DiscoverDesktopBody />)
    await user.click(screen.getByTestId("discover-category-teams"))
    expect(replaceMock).toHaveBeenCalledWith(
      expect.stringContaining("category=teams"),
      expect.any(Object)
    )
  })

  it("clicking an item card pushes ?item= and opens the detail sheet", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DiscoverDesktopBody />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await act(async () => {
      await user.click(screen.getByTestId("discover-item-character-c1"))
    })
    // A history entry, so the browser's Back button closes the detail again.
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("item=c1"), expect.any(Object))
    rerender(<DiscoverDesktopBody />)
    const sheet = screen.getByRole("dialog", { name: "Alpha" })
    expect(sheet).toBeInTheDocument()
    expect(screen.getByTestId("discover-inspector-character-c1")).toBeInTheDocument()
    // The primary actions are there, not just a heading.
    expect(screen.getByTestId("discover-inspector-start-chat")).toBeInTheDocument()
    expect(screen.getByTestId("discover-inspector-favorite")).toBeInTheDocument()
  })

  it("closing a detail it opened pops the entry, so Back and close agree", async () => {
    const user = userEvent.setup()
    startAt("?category=characters")
    const { rerender } = render(<DiscoverDesktopBody />)
    await act(async () => {
      await user.click(screen.getByTestId("discover-item-character-c1"))
    })
    rerender(<DiscoverDesktopBody />)
    await act(async () => {
      await user.click(screen.getByTestId("discover-inspector-close"))
    })
    expect(backMock).toHaveBeenCalledTimes(1)
    rerender(<DiscoverDesktopBody />)
    expect(currentSearch).toBe("?category=characters")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("browser Back and Forward close and re-open the sheet", async () => {
    const user = userEvent.setup()
    startAt("?category=characters")
    const { rerender } = render(<DiscoverDesktopBody />)
    await act(async () => {
      await user.click(screen.getByTestId("discover-item-character-c1"))
    })
    rerender(<DiscoverDesktopBody />)
    expect(screen.getByRole("dialog", { name: "Alpha" })).toBeInTheDocument()

    act(() => backMock())
    rerender(<DiscoverDesktopBody />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    // Forward: the history still holds the item entry.
    act(() => {
      historyIndex += 1
      currentSearch = history[historyIndex] ?? ""
    })
    rerender(<DiscoverDesktopBody />)
    expect(screen.getByRole("dialog", { name: "Alpha" })).toBeInTheDocument()
  })

  it("opens the sheet on a cold deep link and keeps the rail on the overview", () => {
    startAt("?category=characters&item=c1")
    render(<DiscoverDesktopBody />)
    expect(screen.getByRole("dialog", { name: "Alpha" })).toBeInTheDocument()
    expect(screen.getByTestId("discover-inspector-character-c1")).toBeInTheDocument()
    // The rail is the category overview; the detail is not rendered twice.
    expect(screen.getByTestId("discover-inspector-empty")).toBeInTheDocument()
  })

  it("closing a cold deep-linked detail clears ?item= in place", async () => {
    const user = userEvent.setup()
    startAt("?category=characters&item=c1")
    const { rerender } = render(<DiscoverDesktopBody />)
    await act(async () => {
      await user.click(screen.getByTestId("discover-inspector-close"))
    })
    expect(backMock).not.toHaveBeenCalled()
    expect(replaceMock).toHaveBeenCalledWith("/discover?category=characters", expect.any(Object))
    rerender(<DiscoverDesktopBody />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("keeps a category-less ?item= link instead of redirecting to the landing category", () => {
    // A saved landing category used to fire `setCategory`, which drops
    // `?item=`, before the detail could open.
    landingPreference = "skills"
    startAt("?item=c1")
    render(<DiscoverDesktopBody />)
    expect(replaceMock).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "Alpha" })).toBeInTheDocument()
  })

  it("applies the landing category once no item is open", () => {
    landingPreference = "skills"
    startAt("")
    render(<DiscoverDesktopBody />)
    expect(replaceMock).toHaveBeenCalledWith("/discover?category=skills", expect.any(Object))
  })

  it("says so when the deep-linked item does not exist", () => {
    startAt("?category=characters&item=ghost")
    render(<DiscoverDesktopBody />)
    expect(screen.getByTestId("discover-item-sheet-missing")).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "inspector.missingTitle" })).toBeInTheDocument()
  })
})
