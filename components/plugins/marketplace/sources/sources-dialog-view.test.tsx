import { render, screen, fireEvent } from "@testing-library/react"

import { PluginMarketplaceSourcesDialogView } from "./sources-dialog-view"
import type { SourcePreviewState } from "./sources-dialog-view"
import type { MarketplaceSourceItem, RecommendedMarketplaceSource } from "./types"

const SOURCE: MarketplaceSourceItem = {
  id: "acme/plugins",
  name: "Acme Plugins",
  repoRef: "acme/plugins",
  repoUrl: "https://github.com/acme/plugins",
  sync: { kind: "ok", pluginCount: 4, lastSyncedAt: 1_700_000_000_000 },
}

const RECOMMENDED: RecommendedMarketplaceSource[] = [
  { repoRef: "beta/labs", name: "Beta Labs", description: "Community picks." },
]

type Props = React.ComponentProps<typeof PluginMarketplaceSourcesDialogView>

function renderView(over: Partial<Props> = {}) {
  const handlers = {
    onOpenChange: jest.fn(),
    onInputChange: jest.fn(),
    onPreview: jest.fn(),
    onDismissPreview: jest.fn(),
    onConfirmAdd: jest.fn(),
    onRefreshAll: jest.fn(),
    onRefreshSource: jest.fn(),
    onRemoveSource: jest.fn(),
    onOpenRepo: jest.fn(),
    onAddRecommended: jest.fn(),
  }
  render(
    <PluginMarketplaceSourcesDialogView
      open
      input=""
      resolvedRef={null}
      previewState={{ kind: "idle" } as SourcePreviewState}
      adding={false}
      sources={[]}
      refreshingAll={false}
      recommended={[]}
      busyRecommendedRef={null}
      {...handlers}
      {...over}
    />
  )
  return handlers
}

describe("PluginMarketplaceSourcesDialogView", () => {
  it("previews on click and on Enter", () => {
    const { onPreview } = renderView({ input: "acme/plugins" })
    fireEvent.click(screen.getByTestId("marketplace-source-preview-submit"))
    expect(onPreview).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByLabelText("Marketplace repository"), { key: "Enter" })
    expect(onPreview).toHaveBeenCalledTimes(2)
  })

  // The hint is what tells a user that a pasted tree URL collapses to a ref,
  // before they spend one of 60 hourly GitHub requests finding out.
  it("echoes the canonical reference a pasted URL resolves to", () => {
    renderView({
      input: "https://github.com/acme/plugins/tree/main",
      resolvedRef: "acme/plugins@main",
    })
    expect(screen.getByText("Will add acme/plugins@main")).toBeInTheDocument()
  })

  it("drops the hint once the preview is showing", () => {
    renderView({
      input: "acme/plugins",
      resolvedRef: "acme/plugins",
      previewState: {
        kind: "ready",
        preview: {
          id: "acme/plugins",
          name: "Acme Plugins",
          catalogPath: "marketplace.json",
          repoUrl: "https://github.com/acme/plugins",
          alreadyAdded: false,
          entries: [],
        },
      },
    })
    expect(screen.queryByText("Will add acme/plugins")).not.toBeInTheDocument()
    expect(screen.getByTestId("marketplace-source-preview")).toBeInTheDocument()
  })

  it("shows a skeleton while the catalog is being fetched", () => {
    renderView({ previewState: { kind: "loading" } })
    expect(screen.getByTestId("marketplace-source-preview-skeleton")).toBeInTheDocument()
    expect(screen.getByTestId("marketplace-source-preview-submit")).toBeDisabled()
  })

  it("shows a preview failure as an alert", () => {
    renderView({ previewState: { kind: "error", message: "no marketplace.json found" } })
    expect(screen.getByRole("alert")).toHaveTextContent("no marketplace.json found")
  })

  it("lists saved sources and refreshes them all", () => {
    const { onRefreshAll } = renderView({ sources: [SOURCE] })
    expect(screen.getByText("Added sources (1)")).toBeInTheDocument()
    expect(screen.getByTestId("marketplace-source-acme/plugins")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("marketplace-sources-refresh-all"))
    expect(onRefreshAll).toHaveBeenCalled()
  })

  it("falls back to the plain empty sentence when nothing is curated", () => {
    renderView()
    expect(screen.getByText("No sources added yet.")).toBeInTheDocument()
    expect(screen.queryByTestId("marketplace-recommended-sources")).not.toBeInTheDocument()
  })

  it("prefers the curated list over the empty sentence", () => {
    renderView({ recommended: RECOMMENDED })
    expect(screen.getByTestId("marketplace-recommended-sources")).toBeInTheDocument()
    expect(screen.queryByText("No sources added yet.")).not.toBeInTheDocument()
  })

  // Swapping the curated block out with the saved list would strand every
  // curated source after the first one behind manual typing.
  it("keeps offering curated sources alongside saved ones", () => {
    renderView({ sources: [SOURCE], recommended: RECOMMENDED })
    expect(screen.getByTestId("marketplace-source-acme/plugins")).toBeInTheDocument()
    expect(screen.getByTestId("marketplace-recommended-beta/labs")).toBeInTheDocument()
  })

  it("hides the curated block once everything in it is added", () => {
    renderView({
      sources: [{ ...SOURCE, id: "beta/labs", repoRef: "beta/labs" }],
      recommended: RECOMMENDED,
    })
    expect(screen.queryByTestId("marketplace-recommended-sources")).not.toBeInTheDocument()
  })
})
