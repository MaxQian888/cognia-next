/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const useRouterMock = jest.fn()
const useSearchParamsMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => useRouterMock(),
  useSearchParams: () => useSearchParamsMock(),
}))

// Stub every panel so the section test stays focused on the shell behaviour
// (URL resolution, nav rendering, panel switching).
jest.mock("./tabs/overview-tab", () => ({
  SubscriptionOverviewTab: ({ onRequestAddAccount }: { onRequestAddAccount: () => void }) => (
    <button data-testid="overview-panel" onClick={onRequestAddAccount}>
      overview
    </button>
  ),
}))
jest.mock("./tabs/usage-tab", () => ({
  SubscriptionUsageTab: () => <div data-testid="usage-panel">usage</div>,
}))
jest.mock("./tabs/settings-tab", () => ({
  SubscriptionSettingsTab: () => <div data-testid="probes-panel">probes</div>,
}))
jest.mock("./panels/claude-account-panel", () => ({
  ClaudeAccountPanel: () => <div data-testid="claude-panel">claude</div>,
}))
jest.mock("./provider-tab-codex", () => ({
  ProviderTabCodex: () => <div data-testid="codex-panel">codex</div>,
}))
jest.mock("./provider-tab-opencode", () => ({
  ProviderTabOpencode: () => <div data-testid="opencode-panel">opencode</div>,
}))
jest.mock("./import-export-buttons", () => ({
  ImportExportButtons: () => <div data-testid="backup-panel">backup</div>,
}))
jest.mock("./cloud-sync-card", () => ({
  CloudSyncCard: () => <div data-testid="sync-panel">sync</div>,
}))
jest.mock("@/components/settings/common/related-sections-strip", () => ({
  CLAUDE_CODE_RELATED: [],
  RelatedSectionsStrip: () => <div data-testid="related-strip" />,
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { SubscriptionSection } from "./subscription-section"

const replace = jest.fn()

beforeEach(() => {
  jest.resetAllMocks()
  useRouterMock.mockReturnValue({ replace })
  useSearchParamsMock.mockReturnValue(new URLSearchParams())
})

function renderWith(query = "") {
  useSearchParamsMock.mockReturnValue(new URLSearchParams(query))
  render(<SubscriptionSection />)
}

describe("SubscriptionSection", () => {
  it("renders the overview panel by default", () => {
    renderWith()
    expect(screen.getByTestId("overview-panel")).toBeInTheDocument()
  })

  it("renders every nav entry across the three groups", () => {
    renderWith()
    for (const id of [
      "overview",
      "usage",
      "probes",
      "claude",
      "codex",
      "opencode",
      "backup",
      "sync",
    ]) {
      // Desktop nav + mobile Sheet nav can both render; getAllBy tolerates that.
      expect(screen.getAllByTestId(`subscription-nav-item-${id}`).length).toBeGreaterThan(0)
    }
    for (const group of ["usageGroup", "providersGroup", "vaultGroup"]) {
      expect(screen.getAllByTestId(`subscription-nav-group-${group}`).length).toBeGreaterThan(0)
    }
  })

  it("selects a panel from ?subTab=", () => {
    renderWith("subTab=codex")
    expect(screen.getByTestId("codex-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("overview-panel")).not.toBeInTheDocument()
  })

  it("falls back to overview for an unknown ?subTab=", () => {
    renderWith("subTab=ALIEN")
    expect(screen.getByTestId("overview-panel")).toBeInTheDocument()
  })

  // Import/export and cloud sync used to render unconditionally at the bottom of
  // the section, below whatever the active tab was. They are panels now, so they
  // must NOT leak into an unrelated panel.
  it("shows the vault panels only when selected", () => {
    renderWith()
    expect(screen.queryByTestId("backup-panel")).not.toBeInTheDocument()
    expect(screen.queryByTestId("sync-panel")).not.toBeInTheDocument()
  })

  it("renders the backup panel when selected", () => {
    renderWith("subTab=backup")
    expect(screen.getByTestId("backup-panel")).toBeInTheDocument()
  })

  it("clicking a nav entry writes the panel id to ?subTab=", () => {
    renderWith()
    fireEvent.click(screen.getAllByTestId("subscription-nav-item-usage")[0])
    const url = replace.mock.calls.at(-1)![0] as string
    expect(url).toContain("subTab=usage")
  })

  // A stale `innerTab` outranks `subTab` on read, so selecting must drop it or
  // the next render would snap back to the legacy panel.
  it("drops a legacy innerTab param when selecting a panel", () => {
    renderWith("subTab=anthropic&innerTab=usage")
    fireEvent.click(screen.getAllByTestId("subscription-nav-item-codex")[0])
    const url = replace.mock.calls.at(-1)![0] as string
    expect(url).toContain("subTab=codex")
    expect(url).not.toContain("innerTab")
  })

  it("marks the active nav entry", () => {
    renderWith("subTab=sync")
    expect(screen.getAllByTestId("subscription-nav-item-sync")[0]).toHaveAttribute(
      "data-active",
      "true"
    )
    expect(screen.getAllByTestId("subscription-nav-item-overview")[0]).toHaveAttribute(
      "data-active",
      "false"
    )
  })

  it("routes the overview empty-state CTA to the Claude panel", () => {
    renderWith()
    fireEvent.click(screen.getByTestId("overview-panel"))
    const url = replace.mock.calls.at(-1)![0] as string
    expect(url).toContain("subTab=claude")
  })

  describe("legacy deep links", () => {
    it.each([
      ["innerTab=usage", "usage-panel"],
      ["innerTab=account", "claude-panel"],
      ["innerTab=settings", "probes-panel"],
      ["innerTab=overview", "overview-panel"],
      ["subTab=anthropic&innerTab=usage", "usage-panel"],
      ["subTab=anthropic", "overview-panel"],
      ["innerTab=ALIEN", "overview-panel"],
    ])("resolves ?%s to the %s", (query, testId) => {
      renderWith(query)
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    })
  })
})
