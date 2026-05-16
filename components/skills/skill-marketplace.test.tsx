/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

type State = {
  loading: boolean
  error: string | null
  items: Array<{ id: string; source: string; sourceId: string; name: string; category: string }>
}
const ref: { current: { state: State; isSkillsMpEnabled: boolean; source: string } } = {
  current: {
    state: { loading: true, error: null, items: [] },
    isSkillsMpEnabled: false,
    source: "all",
  },
}
jest.mock("@/hooks/skills", () => ({
  useSkillMarketplace: () => ({
    state: ref.current.state,
    isSkillsMpEnabled: ref.current.isSkillsMpEnabled,
    source: ref.current.source,
    setSource: jest.fn(),
    query: "",
    setQuery: jest.fn(),
    refresh: jest.fn(),
    installed: new Set<string>(),
    installingId: null,
    install: jest.fn(),
    uninstall: jest.fn(),
  }),
}))

// The card + detail components aren't under test here — stub them.
jest.mock("./skill-marketplace-card", () => ({
  SkillMarketplaceCard: ({ item }: { item: { name: string } }) => (
    <div data-testid="mp-card">{item.name}</div>
  ),
}))
jest.mock("./skill-marketplace-detail", () => ({
  SkillMarketplaceDetail: () => <div data-testid="mp-detail" />,
}))
jest.mock("./skill-marketplace-empty", () => ({
  SkillMarketplaceEmpty: () => <div data-testid="mp-empty" />,
}))

import { render, screen } from "@testing-library/react"
import { SkillMarketplace } from "./skill-marketplace"

describe("SkillMarketplace", () => {
  it("shows a loading row with the localized label", () => {
    ref.current = {
      state: { loading: true, error: null, items: [] },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("renders the empty teaser when SkillsMP is unconfigured and there are no items", () => {
    ref.current = {
      state: { loading: false, error: null, items: [] },
      isSkillsMpEnabled: false,
      source: "all",
    }
    render(<SkillMarketplace />)
    expect(screen.getByTestId("mp-empty")).toBeInTheDocument()
  })

  it("renders one card per item in the stagger grid", () => {
    ref.current = {
      state: {
        loading: false,
        error: null,
        items: [
          { id: "1", source: "registry", sourceId: "a", name: "Alpha", category: "custom" },
          { id: "2", source: "registry", sourceId: "b", name: "Beta", category: "custom" },
        ],
      },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    expect(screen.getByTestId("skill-marketplace-grid")).toBeInTheDocument()
    expect(screen.getAllByTestId("mp-card")).toHaveLength(2)
  })

  it("shows the localized error message when loading fails", () => {
    ref.current = {
      state: { loading: false, error: "boom", items: [] },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    expect(screen.getByText('errorLoad:{"error":"boom"}')).toBeInTheDocument()
  })
})
