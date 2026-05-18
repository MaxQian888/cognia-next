/**
 * @jest-environment jsdom
 *
 * Tests for the platform gate / desktop-redirect behavior on /discover.
 * `DiscoverPage` is now a thin wrapper around `DiscoverMobileBody`; we
 * stub every mobile card and the Dexie hooks so this stays focused on
 * the gate.
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const routerReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: jest.fn(), back: jest.fn() }),
}))

let platformValue: "tauri" | "mobile" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}))

jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(() => []) }))
jest.mock("@/lib/db/skills", () => ({
  listSkills: jest.fn(() => []),
  setSkillStatus: jest.fn(),
}))
jest.mock("@/lib/db/teams", () => ({ listTeams: jest.fn(() => []) }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    twinDrafts: {
      toCollection: () => ({
        sortBy: () => Promise.resolve([]),
      }),
    },
  }),
}))

jest.mock("@/components/mobile/discover/character-card", () => ({
  CharacterCard: () => <div data-testid="stub-character-card" />,
}))
jest.mock("@/components/mobile/discover/character-detail-sheet", () => ({
  CharacterDetailSheet: () => <div data-testid="stub-character-detail" />,
}))
jest.mock("@/components/mobile/discover/discover-search", () => ({
  DiscoverSearch: () => <div data-testid="stub-discover-search" />,
}))
jest.mock("@/components/mobile/discover/featured-carousel", () => ({
  FeaturedCarousel: () => <div data-testid="stub-featured" />,
}))
jest.mock("@/components/mobile/discover/plugins-panel", () => ({
  PluginsPanel: () => <div data-testid="stub-plugins-panel" />,
}))
jest.mock("@/components/mobile/discover/team-card", () => ({
  TeamCard: () => <div data-testid="stub-team-card" />,
}))
jest.mock("@/components/mobile/discover/skill-card", () => ({
  SkillCard: () => <div data-testid="stub-skill-card" />,
}))
jest.mock("@/components/mobile/discover/twin-drafts-panel", () => ({
  TwinDraftsPanel: () => <div data-testid="stub-twin-drafts" />,
}))
jest.mock("@/components/mobile/discover/twin-sources-panel", () => ({
  TwinSourcesPanel: () => <div data-testid="stub-twin-sources" />,
}))
jest.mock("@/components/mobile/empty-state", () => ({
  EmptyState: () => <div data-testid="stub-empty-state" />,
}))

import DiscoverPage from "./page"

beforeEach(() => {
  routerReplace.mockReset()
  platformValue = "web"
})

describe("DiscoverPage platform gate", () => {
  it("renders the mobile body when platform === 'mobile'", () => {
    platformValue = "mobile"
    render(<DiscoverPage />)
    expect(screen.getByTestId("discover-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-discover-search")).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it("renders null and redirects to /agent-teams on web", () => {
    platformValue = "web"
    const { container } = render(<DiscoverPage />)
    expect(container.firstChild).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith("/agent-teams")
  })

  it("renders null and redirects to /agent-teams on Tauri", () => {
    platformValue = "tauri"
    const { container } = render(<DiscoverPage />)
    expect(container.firstChild).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith("/agent-teams")
  })
})
