/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}))

jest.mock("@/lib/skills/marketplace-install", () => ({
  fetchMarketplaceContent: jest.fn(async () => ({ content: "# Readme" })),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillMarketplaceDetail } from "./skill-marketplace-detail"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"

const item: MarketplaceItem = {
  id: "mp:registry/x",
  source: "registry",
  sourceId: "x",
  name: "X",
  category: "custom",
}

describe("SkillMarketplaceDetail", () => {
  it("renders the install button when not installed", async () => {
    render(
      <SkillMarketplaceDetail
        item={item}
        installed={false}
        installing={false}
        onClose={jest.fn()}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(screen.getByText("install")).toBeInTheDocument()
    await screen.findByTestId("markdown-renderer")
  })

  it("renders the uninstall button when installed", async () => {
    render(
      <SkillMarketplaceDetail
        item={item}
        installed
        installing={false}
        onClose={jest.fn()}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(screen.getByText("uninstall")).toBeInTheDocument()
    await screen.findByTestId("markdown-renderer")
  })

  it("invokes onClose when the sheet is dismissed", async () => {
    const onClose = jest.fn()
    render(
      <SkillMarketplaceDetail
        item={item}
        installed={false}
        installing={false}
        onClose={onClose}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    await screen.findByTestId("markdown-renderer")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })
})
