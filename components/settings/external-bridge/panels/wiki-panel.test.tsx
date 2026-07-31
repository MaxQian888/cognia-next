import { render, screen } from "@testing-library/react"

import { BridgeWikiPanel } from "./wiki-panel"

jest.mock("../wiki-rebuild-card", () => ({
  WikiRebuildCard: () => <div data-testid="wiki-rebuild-card" />,
}))
jest.mock("../wiki-lint-card", () => ({
  WikiLintCard: () => <div data-testid="wiki-lint-card" />,
}))

describe("BridgeWikiPanel", () => {
  it("hosts both wiki maintenance cards", () => {
    // Rebuild and lint run over the same corpus, so they share one panel rather
    // than each owning a nav entry.
    render(<BridgeWikiPanel />)

    expect(screen.getByTestId("wiki-rebuild-card")).toBeInTheDocument()
    expect(screen.getByTestId("wiki-lint-card")).toBeInTheDocument()
  })
})
