/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock(
  "streamdown",
  () => ({
    __esModule: true,
    Streamdown: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="streamdown">{children}</div>
    ),
  }),
  { virtual: true }
)

jest.mock("@/lib/skills/marketplace-install", () => ({
  fetchMarketplaceContent: jest.fn(async () => ({ content: "# Readme" })),
}))

import { render, screen } from "@testing-library/react"
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
  it("renders the install button when not installed", () => {
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
  })

  it("renders the uninstall button when installed", () => {
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
  })
})
