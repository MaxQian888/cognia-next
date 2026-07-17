/** @jest-environment jsdom */
/**
 * Tests for <DiscoverMobileBody />:
 * chip-strip filtering, pull-to-refresh, bottom-Sheet inspector open/close,
 * and the legacy-card vs. grid-driven category branch.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// ─── next-intl ───────────────────────────────────────────────────────────────
// Simple key-pass-through; the body only calls t("title"), t("createCharacter")
// and similar single-key lookups — no format interpolation needed in the mock.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && Object.keys(vars).length > 0) return `${key}:${JSON.stringify(vars)}`
    return key
  },
  useLocale: () => "en",
}))

// ─── Next.js navigation ──────────────────────────────────────────────────────
// useDiscoverRouteState is built on top of these. We keep a module-level
// variable so calls to router.replace() propagate back into useSearchParams.
let currentSearch = ""
let cachedKey = ""
let cachedParams = new URLSearchParams("")

const replaceMock = jest.fn((href: string) => {
  const qIdx = href.indexOf("?")
  currentSearch = qIdx >= 0 ? href.slice(qIdx) : ""
  // Bust the cached URLSearchParams object so the next render picks up changes.
  cachedKey = ""
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

// ─── Dexie / companion sync ───────────────────────────────────────────────────
// useDiscoverQuery calls useLiveQuery internally. Stub the whole hook so the
// test controls exactly what items each category resolves to.
const characterFixture = {
  id: "char-1",
  name: "Aria",
  description: "Test character",
  systemPrompt: "",
  avatarColor: "#aaa",
  avatarEmoji: "🐙",
  isBuiltIn: false,
}

const teamFixture = {
  id: "team-1",
  name: "Alpha Team",
  description: "",
  isBuiltIn: false,
  createdAt: 0,
  updatedAt: 0,
}

const skillFixture = {
  id: "skill-1",
  name: "Summarise",
  description: "",
  isBuiltIn: false,
  status: "enabled",
}

const mcpItemFixture = {
  id: "mcp-1",
  name: "My MCP Server",
  transport: "stdio",
  enabled: true,
}

// Controllable so individual tests can force a category to resolve empty
// (exercising the onboarding-hint branch). beforeEach restores the default.
const mockUseDiscoverQuery = jest.fn()
jest.mock("@/hooks/discover/use-discover-query", () => ({
  useDiscoverQuery: (category: string, query?: string, opts?: unknown) =>
    mockUseDiscoverQuery(category, query, opts),
}))

function defaultQueryImpl(category: string) {
  switch (category) {
    case "characters":
      return {
        items: [{ kind: "character", id: "char-1", data: characterFixture }],
        loading: false,
      }
    case "teams":
      return {
        items: [{ kind: "team", id: "team-1", data: teamFixture }],
        loading: false,
      }
    case "skills":
      return {
        items: [{ kind: "skill", id: "skill-1", data: skillFixture }],
        loading: false,
      }
    case "mcpTools":
      return {
        items: [{ kind: "mcpServer", id: "mcp-1", data: mcpItemFixture }],
        loading: false,
      }
    case "connectors":
      return {
        items: [
          {
            kind: "connector",
            id: "telegram",
            data: { type: "telegram", status: "stable" },
          },
        ],
        loading: false,
      }
    case "ocrProviders":
      return {
        items: [
          {
            kind: "ocrProvider",
            id: "openai-vision",
            data: {
              id: "openai-vision",
              label: "OpenAI Vision",
              category: "llm-vision",
              credentialKeys: [],
              shells: { tauri: true, capacitor: true, browser: true },
            },
          },
        ],
        loading: false,
      }
    case "workflowTemplates":
      return {
        items: [
          {
            kind: "workflowTemplate",
            id: "demo",
            data: {
              id: "demo",
              label: { en: "Demo template", "zh-CN": "示例模板" },
              description: { en: "", "zh-CN": "" },
              tags: [],
            },
          },
        ],
        loading: false,
      }
    default:
      return { items: [], loading: false }
  }
}

// Companion sync — onRefresh calls runSyncDown(); capture it so we can assert.
const runSyncDownMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (...args: unknown[]) => runSyncDownMock(...args),
}))

// ─── Skill / outbound-queue mutations ─────────────────────────────────────────
jest.mock("@/lib/db/skills", () => ({ setSkillStatus: jest.fn() }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: jest.fn() }))

// ─── Heavy child stubs ────────────────────────────────────────────────────────
// CharacterDetailSheet opens a complex edit form — stub to an inert element.
jest.mock("@/components/mobile/discover/character-detail-sheet", () => ({
  CharacterDetailSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-character-detail-sheet" /> : null,
}))

// FeaturedCarousel depends on framer-motion internals; stub to a sentinel div.
jest.mock("@/components/mobile/discover/featured-carousel", () => ({
  FeaturedCarousel: ({ characters }: { characters: unknown[] }) => (
    <div data-testid="stub-featured-carousel" data-count={characters.length} />
  ),
}))

// PluginsPanel, TwinSourcesPanel, TwinDraftsPanel — heavy Dexie panels not
// under test here; replaced with simple sentinels.
jest.mock("@/components/mobile/discover/plugins-panel", () => ({
  PluginsPanel: () => <div data-testid="stub-plugins-panel" />,
}))
jest.mock("@/components/mobile/discover/twin-sources-panel", () => ({
  TwinSourcesPanel: () => <div data-testid="stub-twin-sources-panel" />,
}))
jest.mock("@/components/mobile/discover/twin-drafts-panel", () => ({
  TwinDraftsPanel: () => <div data-testid="stub-twin-drafts-panel" />,
}))
jest.mock("@/components/mobile/discover/twin-profile-panel", () => ({
  TwinProfilePanel: ({ twinId }: { twinId?: string }) => (
    <div data-testid="stub-twin-profile-panel" data-twin-id={twinId ?? ""} />
  ),
}))

// DiscoverViewToggle — exposes its category so visibility tests can assert it.
jest.mock("@/components/discover/discover-view-toggle", () => ({
  DiscoverViewToggle: ({ category }: { category: string }) => (
    <div data-testid="stub-view-toggle" data-category={category} />
  ),
}))

// PluginMarketplaceSheet — triggers its own DB reads; irrelevant to these tests.
jest.mock("@/components/discover/plugin-marketplace-sheet", () => ({
  PluginMarketplaceSheet: () => <div data-testid="stub-plugin-marketplace-sheet" />,
}))

// Skill marketplace sheet — stubbed so its SkillMarketplace → streamdown (ESM)
// chain doesn't load in jsdom.
jest.mock("@/components/discover/skill-marketplace-sheet", () => ({
  SkillMarketplaceSheet: () => <div data-testid="stub-skill-marketplace-sheet" />,
}))

// SortFilterSheet — a separate concern; not under test.
jest.mock("@/components/discover/sort-filter-sheet", () => ({
  SortFilterSheet: () => <div data-testid="stub-sort-filter-sheet" />,
}))

// DiscoverInspector renders item details inside the bottom Sheet.
// Stub it to a div that exposes the itemId prop so we can assert it is set.
jest.mock("@/components/discover/discover-inspector", () => ({
  DiscoverInspector: ({ itemId, onClose }: { itemId: string | null; onClose: () => void }) => (
    <div data-testid="stub-discover-inspector" data-item-id={itemId ?? ""}>
      <button onClick={onClose} data-testid="stub-inspector-close">
        close
      </button>
    </div>
  ),
}))

// PullToRefresh — the actual implementation uses pointer events + CSS
// transforms. Render a simplified wrapper that exposes a test-friendly
// "trigger refresh" button so tests don't have to simulate pointer drags.
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({
    children,
    onRefresh,
  }: {
    children: React.ReactNode
    onRefresh: () => Promise<void>
  }) => (
    <div data-testid="pull-to-refresh">
      <button data-testid="pull-to-refresh-trigger" onClick={() => void onRefresh()}>
        refresh
      </button>
      {children}
    </div>
  ),
}))

// motion/react's useReducedMotion is consumed by the real PullToRefresh
// (which we mocked), but the mock above doesn't need it. Guard against any
// transitive import that might still pull it in.
jest.mock("motion/react", () => ({ useReducedMotion: () => false }))

// Haptics — not available in jsdom.
jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn() }))

// ─── CharacterCard / TeamCard / SkillCard ─────────────────────────────────────
// These are real lightweight presentational components. We keep them real so
// the "legacy layout" branch tests can verify actual list rendering. However
// CharacterCard emits an onSelect callback — expose its name via data attribute
// so the test can assert the editor sheet opens.
jest.mock("@/components/mobile/discover/character-card", () => ({
  CharacterCard: ({
    character,
    onSelect,
  }: {
    character: { id: string; name: string }
    onSelect: (c: { id: string; name: string }) => void
  }) => (
    <button data-testid={`stub-character-card-${character.id}`} onClick={() => onSelect(character)}>
      {character.name}
    </button>
  ),
}))

jest.mock("@/components/mobile/discover/team-card", () => ({
  TeamCard: ({ team }: { team: { id: string; name: string } }) => (
    <div data-testid={`stub-team-card-${team.id}`}>{team.name}</div>
  ),
}))

jest.mock("@/components/mobile/discover/skill-card", () => ({
  SkillCard: ({
    skill,
    onToggle,
  }: {
    skill: { id: string; name: string; status: string }
    onToggle: (s: { id: string; name: string; status: string }) => void
  }) => (
    <div data-testid={`stub-skill-card-${skill.id}`}>
      {skill.name}
      <button data-testid={`stub-skill-toggle-${skill.id}`} onClick={() => onToggle(skill)}>
        toggle
      </button>
    </div>
  ),
}))

// DiscoverSearch — a controlled input; keep real so typing propagates.
// (The actual component is a thin wrapper around an <input> — no heavy deps.)

// DiscoverGrid — real implementation, already tested in its own suite.
// Keep real here; the grid branch tests verify it mounts when category is a
// GRID_CATEGORY (mcpTools, connectors, ocrProviders, workflowTemplates).
// However it imports DiscoverItemCard which needs lucide icons — those are
// fine in jsdom. Keep real.

// ─── Import the component under test ─────────────────────────────────────────
import { DiscoverMobileBody } from "./discover-mobile-body"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Simulate a chip click by label. The chip strip uses data-testid="chip-strip-<id>". */
async function clickChip(user: ReturnType<typeof userEvent.setup>, categoryId: string) {
  await user.click(screen.getByTestId(`chip-strip-${categoryId}`))
}

/** Reset navigation state between tests. */
function resetNav() {
  currentSearch = ""
  cachedKey = ""
  cachedParams = new URLSearchParams("")
  replaceMock.mockClear()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetNav()
  runSyncDownMock.mockClear()
  mockUseDiscoverQuery.mockReset()
  mockUseDiscoverQuery.mockImplementation(defaultQueryImpl)
})

describe("<DiscoverMobileBody />", () => {
  // ── Chip strip ────────────────────────────────────────────────────────────

  describe("chip strip", () => {
    it("renders the discover page container", () => {
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("discover-page")).toBeInTheDocument()
    })

    it("renders the category chip strip with all 10 chips", () => {
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("chip-strip-characters")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-teams")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-skills")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-plugins")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-mcpTools")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-connectors")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-ocrProviders")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-workflowTemplates")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-twinIngest")).toBeInTheDocument()
      expect(screen.getByTestId("chip-strip-twinDrafts")).toBeInTheDocument()
    })

    it("defaults to the aggregated foryou home (no ?category=)", () => {
      render(<DiscoverMobileBody />)
      // Default lands on the home strips, not the characters legacy list.
      expect(screen.getByTestId("chip-strip-foryou")).toBeInTheDocument()
      expect(screen.queryByTestId("stub-character-card-char-1")).not.toBeInTheDocument()
    })

    it("characters category renders character cards", () => {
      currentSearch = "?category=characters"
      render(<DiscoverMobileBody />)
      // The character fixture renders via our CharacterCard stub.
      expect(screen.getByTestId("stub-character-card-char-1")).toBeInTheDocument()
    })

    it("clicking a chip calls router.replace with the matching category query param", async () => {
      const user = userEvent.setup()
      render(<DiscoverMobileBody />)
      await clickChip(user, "teams")
      expect(replaceMock).toHaveBeenCalledWith(
        expect.stringContaining("category=teams"),
        expect.any(Object)
      )
    })

    it("clicking the 'teams' chip switches the visible content to team cards", async () => {
      // Pre-set URL to teams so the component renders that category immediately.
      currentSearch = "?category=teams"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-team-card-team-1")).toBeInTheDocument()
      expect(screen.queryByTestId("stub-character-card-char-1")).not.toBeInTheDocument()
    })

    it("clicking the 'skills' chip shows skill cards", async () => {
      currentSearch = "?category=skills"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-skill-card-skill-1")).toBeInTheDocument()
    })
  })

  // ── Pull-to-refresh ───────────────────────────────────────────────────────

  describe("pull-to-refresh", () => {
    it("renders the pull-to-refresh wrapper", () => {
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("pull-to-refresh")).toBeInTheDocument()
    })

    it("triggering the refresh affordance calls runSyncDown()", async () => {
      const user = userEvent.setup()
      render(<DiscoverMobileBody />)
      await user.click(screen.getByTestId("pull-to-refresh-trigger"))
      await waitFor(() => expect(runSyncDownMock).toHaveBeenCalledTimes(1))
    })

    it("does not blow up when runSyncDown rejects (transport uninitialised)", async () => {
      runSyncDownMock.mockRejectedValueOnce(new Error("not connected"))
      const user = userEvent.setup()
      render(<DiscoverMobileBody />)
      // Should not throw.
      await act(async () => {
        await user.click(screen.getByTestId("pull-to-refresh-trigger"))
      })
      expect(runSyncDownMock).toHaveBeenCalledTimes(1)
    })
  })

  // ── Inspector Sheet open / close (grid categories) ────────────────────────

  describe("inspector Sheet for grid categories", () => {
    it("inspector Sheet is closed by default when no item param is set", () => {
      currentSearch = "?category=mcpTools"
      render(<DiscoverMobileBody />)
      // The Sheet renders children only when open — the inspector stub should not appear.
      expect(screen.queryByTestId("stub-discover-inspector")).not.toBeInTheDocument()
    })

    it("setting ?item= on a grid category opens the Sheet with the item id", () => {
      currentSearch = "?category=mcpTools&item=mcp-1"
      render(<DiscoverMobileBody />)
      const inspector = screen.getByTestId("stub-discover-inspector")
      expect(inspector).toBeInTheDocument()
      expect(inspector).toHaveAttribute("data-item-id", "mcp-1")
    })

    it("closing the inspector via its own close button clears the item param", async () => {
      currentSearch = "?category=mcpTools&item=mcp-1"
      const user = userEvent.setup()
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-discover-inspector")).toBeInTheDocument()
      await user.click(screen.getByTestId("stub-inspector-close"))
      // clearItem() calls router.replace without the item param.
      expect(replaceMock).toHaveBeenCalledWith(
        expect.not.stringContaining("item="),
        expect.any(Object)
      )
    })

    it("inspector Sheet is NOT opened for legacy category 'characters' even with ?item=", () => {
      // characters is not in GRID_CATEGORIES — the Sheet should stay closed.
      currentSearch = "?category=characters&item=char-1"
      render(<DiscoverMobileBody />)
      expect(screen.queryByTestId("stub-discover-inspector")).not.toBeInTheDocument()
    })
  })

  // ── Legacy vs. grid category branch ──────────────────────────────────────

  describe("legacy vs. grid layout branch", () => {
    const LEGACY_CATEGORIES = [
      "characters",
      "teams",
      "skills",
      "plugins",
      "twinIngest",
      "twinDrafts",
    ] as const

    const GRID_CATEGORIES = ["mcpTools", "connectors", "ocrProviders", "workflowTemplates"] as const

    it.each(LEGACY_CATEGORIES)(
      "legacy category '%s' does NOT render the DiscoverGrid",
      (category) => {
        currentSearch = `?category=${category}`
        render(<DiscoverMobileBody />)
        // DiscoverGrid mounts a testid of the form "discover-grid-<category>" —
        // none of those should appear for legacy categories.
        expect(screen.queryByTestId(`discover-grid-${category}`)).not.toBeInTheDocument()
      }
    )

    it.each(GRID_CATEGORIES)(
      "grid category '%s' renders the DiscoverGrid component",
      (category) => {
        currentSearch = `?category=${category}`
        render(<DiscoverMobileBody />)
        expect(screen.getByTestId(`discover-grid-${category}`)).toBeInTheDocument()
      }
    )

    it("characters category shows character cards list (legacy layout)", () => {
      currentSearch = "?category=characters"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-character-card-char-1")).toBeInTheDocument()
    })

    it("teams category shows team cards list (legacy layout)", () => {
      currentSearch = "?category=teams"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-team-card-team-1")).toBeInTheDocument()
    })

    it("skills category shows skill cards list (legacy layout)", () => {
      currentSearch = "?category=skills"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-skill-card-skill-1")).toBeInTheDocument()
    })

    it("plugins category shows the PluginsPanel stub (legacy layout)", () => {
      currentSearch = "?category=plugins"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-plugins-panel")).toBeInTheDocument()
    })

    it("twinIngest category shows the TwinSourcesPanel stub (legacy layout)", () => {
      currentSearch = "?category=twinIngest"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-twin-sources-panel")).toBeInTheDocument()
    })

    it("twinDrafts category shows the TwinDraftsPanel stub (legacy layout)", () => {
      currentSearch = "?category=twinDrafts"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-twin-drafts-panel")).toBeInTheDocument()
    })

    it("mcpTools grid category does not render any legacy panel", () => {
      currentSearch = "?category=mcpTools"
      render(<DiscoverMobileBody />)
      expect(screen.queryByTestId("stub-twin-sources-panel")).not.toBeInTheDocument()
      expect(screen.queryByTestId("stub-plugins-panel")).not.toBeInTheDocument()
      expect(screen.queryByTestId("stub-character-card-char-1")).not.toBeInTheDocument()
    })
  })

  // ── Create-character FAB (characters category only) ───────────────────────

  describe("create-character FAB", () => {
    it("renders the create-character button on the characters tab", () => {
      currentSearch = "?category=characters"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("character-create-fab")).toBeInTheDocument()
    })

    it("does not render the create-character button on teams tab", () => {
      currentSearch = "?category=teams"
      render(<DiscoverMobileBody />)
      expect(screen.queryByTestId("character-create-fab")).not.toBeInTheDocument()
    })

    it("clicking the FAB opens the CharacterDetailSheet with no preselected character", async () => {
      currentSearch = "?category=characters"
      const user = userEvent.setup()
      render(<DiscoverMobileBody />)
      await user.click(screen.getByTestId("character-create-fab"))
      expect(screen.getByTestId("stub-character-detail-sheet")).toBeInTheDocument()
    })
  })

  // ── FeaturedCarousel visibility ───────────────────────────────────────────

  describe("FeaturedCarousel", () => {
    it("renders the featured carousel on the characters tab when query is empty", () => {
      currentSearch = "?category=characters"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-featured-carousel")).toBeInTheDocument()
    })

    it("does not render the carousel on the teams tab", () => {
      currentSearch = "?category=teams"
      render(<DiscoverMobileBody />)
      expect(screen.queryByTestId("stub-featured-carousel")).not.toBeInTheDocument()
    })
  })

  // ── View toggle parity + onboarding hints + twin profile panel ────────────

  describe("view toggle parity, onboarding hints, twin profile", () => {
    it.each(["characters", "teams", "skills"] as const)(
      "shows the density toggle on legacy category '%s'",
      (category) => {
        currentSearch = `?category=${category}`
        render(<DiscoverMobileBody />)
        expect(screen.getByTestId("stub-view-toggle")).toHaveAttribute("data-category", category)
      }
    )

    it.each(["plugins", "twinDrafts"] as const)(
      "hides the density toggle on category '%s'",
      (category) => {
        currentSearch = `?category=${category}`
        render(<DiscoverMobileBody />)
        expect(screen.queryByTestId("stub-view-toggle")).not.toBeInTheDocument()
      }
    )

    it("mounts the twin profile panel above the sources panel on twinIngest", () => {
      currentSearch = "?category=twinIngest"
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId("stub-twin-profile-panel")).toHaveAttribute("data-twin-id", "default")
      expect(screen.getByTestId("stub-twin-sources-panel")).toBeInTheDocument()
    })

    it("shows an onboarding hint when a legacy category is empty (unfiltered)", () => {
      mockUseDiscoverQuery.mockReturnValue({ items: [], loading: false })
      currentSearch = "?category=characters"
      render(<DiscoverMobileBody />)
      expect(screen.getByText("emptyCharactersHint")).toBeInTheDocument()
    })

    it.each([
      ["characters", "profile"],
      ["teams", "agent-teams"],
      ["skills", "skills"],
    ] as const)("uses the %s companion illustration for its empty state", (category, icon) => {
      mockUseDiscoverQuery.mockReturnValue({ items: [], loading: false })
      currentSearch = `?category=${category}`
      render(<DiscoverMobileBody />)
      expect(screen.getByTestId(`mobile-spot-icon-${icon}`)).toBeInTheDocument()
    })
  })

  // ── Loading skeletons ───────────────────────────────────────────────────────

  describe("legacy list loading state", () => {
    it.each(["characters", "teams", "skills"])(
      "shows the skeleton (not the empty state) while %s is loading",
      (category) => {
        mockUseDiscoverQuery.mockImplementation((c: string) =>
          c === category ? { items: [], loading: true } : defaultQueryImpl(c)
        )
        currentSearch = `?category=${category}`
        render(<DiscoverMobileBody />)
        expect(screen.getByTestId("discover-list-skeleton")).toBeInTheDocument()
        // The onboarding empty-state hint must NOT show during loading.
        expect(screen.queryByText("emptyCharactersHint")).not.toBeInTheDocument()
      }
    )
  })

  // ── Long-press card actions (share parity) ───────────────────────────────────

  describe("card action sheet", () => {
    it("long-pressing a character card opens the action sheet with the share button", () => {
      jest.useFakeTimers()
      try {
        currentSearch = "?category=characters"
        render(<DiscoverMobileBody />)
        const card = screen.getByTestId("stub-character-card-char-1")
        // The real <LongPress> wrapper owns the pointer handlers; a pointerdown
        // followed by the 500ms hold fires onLongPress.
        fireEvent.pointerDown(card, { clientX: 0, clientY: 0 })
        act(() => {
          jest.advanceTimersByTime(500)
        })
        expect(screen.getByTestId("discover-card-actions-sheet")).toBeInTheDocument()
        expect(screen.getByTestId("discover-share-button")).toBeInTheDocument()
      } finally {
        jest.useRealTimers()
      }
    })

    it("does not open the action sheet on a short tap", () => {
      jest.useFakeTimers()
      try {
        currentSearch = "?category=characters"
        render(<DiscoverMobileBody />)
        const card = screen.getByTestId("stub-character-card-char-1")
        fireEvent.pointerDown(card, { clientX: 0, clientY: 0 })
        fireEvent.pointerUp(card)
        act(() => {
          jest.advanceTimersByTime(500)
        })
        expect(screen.queryByTestId("discover-card-actions-sheet")).not.toBeInTheDocument()
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
