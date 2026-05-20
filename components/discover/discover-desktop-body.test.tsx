/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character } from "@/lib/claude/types"

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

// Stand-in for useIsMobile inside FeaturePageShell — the desktop body test
// asserts the 3-pane desktop layout, not the mobile collapse behaviour.
jest.mock("@/hooks/ui", () => ({
  useIsMobile: () => false,
}))

// Capture URL state in a module-level var so router.replace updates flow
// back through useSearchParams on re-render.
let currentSearch = ""
let cachedKey = ""
let cachedParams = new URLSearchParams("")
const replaceMock = jest.fn((href: string) => {
  const qIdx = href.indexOf("?")
  currentSearch = qIdx >= 0 ? href.slice(qIdx) : ""
})
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: replaceMock,
    push: jest.fn(),
    back: jest.fn(),
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
jest.mock("@/lib/db/skills", () => ({ setSkillStatus: jest.fn() }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    plugins: { update: jest.fn() },
    mcpServers: { update: jest.fn() },
  }),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { DiscoverDesktopBody } from "./discover-desktop-body"

beforeEach(() => {
  currentSearch = ""
  cachedKey = ""
  cachedParams = new URLSearchParams("")
  replaceMock.mockClear()
})

describe("<DiscoverDesktopBody />", () => {
  it("renders the feature shell with the desktop toolbar + grid", () => {
    render(<DiscoverDesktopBody />)
    expect(screen.getByTestId("discover-desktop-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("discover-grid-characters")).toBeInTheDocument()
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

  it("clicking an item card writes ?item= to the URL", async () => {
    const user = userEvent.setup()
    render(<DiscoverDesktopBody />)
    await act(async () => {
      await user.click(screen.getByTestId("discover-item-character-c1"))
    })
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("item=c1"), expect.any(Object))
  })

  it("hydrates the inspector with the item named by ?item=", () => {
    currentSearch = "?category=characters&item=c1"
    render(<DiscoverDesktopBody />)
    expect(screen.getByTestId("discover-inspector-character-c1")).toBeInTheDocument()
    expect(screen.getByTestId("discover-inspector-title")).toHaveTextContent("Alpha")
  })
})
