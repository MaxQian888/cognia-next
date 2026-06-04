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

const fetchMarketplaceContent = jest.fn(async () => ({ content: "# Readme" }))
jest.mock("@/lib/skills/marketplace-install", () => ({
  fetchMarketplaceContent: (...args: unknown[]) =>
    fetchMarketplaceContent(...(args as Parameters<typeof fetchMarketplaceContent>)),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillMarketplaceDetailContent } from "./skill-marketplace-detail-content"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"

const item: MarketplaceItem = {
  id: "mp:registry/x",
  source: "registry",
  sourceId: "x",
  name: "X",
  category: "custom",
}

describe("SkillMarketplaceDetailContent", () => {
  it("renders the item name and install button when not installed", async () => {
    render(
      <SkillMarketplaceDetailContent
        item={item}
        installed={false}
        installing={false}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(screen.getByText("X")).toBeInTheDocument()
    expect(screen.getByText("install")).toBeInTheDocument()
    await screen.findByTestId("streamdown")
  })

  it("renders the uninstall button when installed", async () => {
    render(
      <SkillMarketplaceDetailContent
        item={item}
        installed
        installing={false}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(screen.getByText("uninstall")).toBeInTheDocument()
    await screen.findByTestId("streamdown")
  })

  it("invokes onInstall when the install button is clicked", async () => {
    const onInstall = jest.fn()
    render(
      <SkillMarketplaceDetailContent
        item={item}
        installed={false}
        installing={false}
        onInstall={onInstall}
        onUninstall={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("install"))
    expect(onInstall).toHaveBeenCalledWith(item)
    await screen.findByTestId("streamdown")
  })

  it("renders the fetched readme", async () => {
    render(
      <SkillMarketplaceDetailContent
        item={item}
        installed={false}
        installing={false}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(await screen.findByTestId("streamdown")).toHaveTextContent("# Readme")
  })

  it("renders author and repository metadata in the header", async () => {
    render(
      <SkillMarketplaceDetailContent
        item={{
          ...item,
          author: "alice",
          repository: "alice/skills",
          license: "MIT",
          tags: ["a"],
          description: "Great skill",
        }}
        installed={false}
        installing={false}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    const repoLink = screen.getByText("alice/skills").closest("a")
    expect(repoLink).toHaveAttribute("href", "https://github.com/alice/skills")
    expect(repoLink?.closest("p")).toHaveTextContent('byAuthor:{"author":"alice"}')
    expect(screen.getByText('license:{"name":"MIT"}')).toBeInTheDocument()
    expect(screen.getByText("Great skill")).toBeInTheDocument()
    await screen.findByTestId("streamdown")
  })

  it("uses an http(s) repository value as the link href verbatim", async () => {
    render(
      <SkillMarketplaceDetailContent
        item={{ ...item, repository: "https://gitlab.com/x/y" }}
        installed={false}
        installing={false}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(screen.getByText("https://gitlab.com/x/y").closest("a")).toHaveAttribute(
      "href",
      "https://gitlab.com/x/y"
    )
    await screen.findByTestId("streamdown")
  })

  it("shows the fetch error when the readme fails to load", async () => {
    fetchMarketplaceContent.mockRejectedValueOnce(new Error("offline"))
    render(
      <SkillMarketplaceDetailContent
        item={item}
        installed={false}
        installing={false}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(await screen.findByText("offline")).toBeInTheDocument()
  })

  it("stringifies non-Error fetch failures", async () => {
    fetchMarketplaceContent.mockRejectedValueOnce("plain failure")
    render(
      <SkillMarketplaceDetailContent
        item={item}
        installed={false}
        installing={false}
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(await screen.findByText("plain failure")).toBeInTheDocument()
  })

  it("disables the action and shows a spinner while installing", async () => {
    render(
      <SkillMarketplaceDetailContent
        item={item}
        installed={false}
        installing
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(screen.getByText("installing").closest("button")).toBeDisabled()
    await screen.findByTestId("streamdown")
  })

  it("disables the uninstall action while installing for an installed item", async () => {
    render(
      <SkillMarketplaceDetailContent
        item={item}
        installed
        installing
        onInstall={jest.fn()}
        onUninstall={jest.fn()}
      />
    )
    expect(screen.getByText("uninstall").closest("button")).toBeDisabled()
    await screen.findByTestId("streamdown")
  })
})
