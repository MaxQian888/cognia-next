import { render, screen, fireEvent } from "@testing-library/react"

import { PluginSourcePreviewCard } from "./source-preview-card"
import type { MarketplaceSourcePreview } from "./types"

function makePreview(over: Partial<MarketplaceSourcePreview> = {}): MarketplaceSourcePreview {
  return {
    id: "acme/plugins",
    name: "Acme Plugins",
    owner: "Acme Labs",
    catalogPath: "marketplace.json",
    repoUrl: "https://github.com/acme/plugins",
    alreadyAdded: false,
    entries: Array.from({ length: 7 }, (_, i) => ({
      id: `acme/plugins:p${i}`,
      name: `plugin-${i}`,
      version: `1.0.${i}`,
      description: `does thing ${i}`,
    })),
    ...over,
  }
}

function renderCard(over: Partial<MarketplaceSourcePreview> = {}, props = {}) {
  const onAdd = jest.fn()
  const onCancel = jest.fn()
  const onOpenRepo = jest.fn()
  const result = render(
    <PluginSourcePreviewCard
      preview={makePreview(over)}
      adding={false}
      onAdd={onAdd}
      onCancel={onCancel}
      onOpenRepo={onOpenRepo}
      {...props}
    />
  )
  return { onAdd, onCancel, onOpenRepo, ...result }
}

describe("PluginSourcePreviewCard", () => {
  it("shows the catalog identity and plugin count", () => {
    renderCard()
    expect(screen.getByText("Acme Plugins")).toBeInTheDocument()
    expect(screen.getByText("by Acme Labs")).toBeInTheDocument()
    expect(screen.getByText("7 plugins")).toBeInTheDocument()
    expect(screen.getByText("acme/plugins")).toBeInTheDocument()
  })

  it("collapses to five rows and expands the rest", () => {
    renderCard()
    expect(screen.getByText("plugin-4")).toBeInTheDocument()
    expect(screen.queryByText("plugin-5")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "…and 2 more" }))
    expect(screen.getByText("plugin-6")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }))
    expect(screen.queryByText("plugin-6")).not.toBeInTheDocument()
  })

  it("has no expander when the catalog fits", () => {
    renderCard({ entries: makePreview().entries.slice(0, 3) })
    expect(screen.queryByRole("button", { name: /more/ })).not.toBeInTheDocument()
  })

  it("says an empty catalog is still addable", () => {
    renderCard({ entries: [] })
    expect(screen.getByText(/lists no plugins yet/i)).toBeInTheDocument()
    expect(screen.getByText("no plugins")).toBeInTheDocument()
    expect(screen.getByTestId("marketplace-source-preview-add")).toBeEnabled()
  })

  it("always states that the plugins are unreviewed", () => {
    const { container } = renderCard()
    expect(screen.getByRole("alert")).toHaveTextContent(/doesn't review these plugins/i)
    expect(container.querySelector("[data-slot='card-header']")).not.toBeNull()
    expect(container.querySelector("[data-slot='card-content']")).not.toBeNull()
    expect(container.querySelector("[data-slot='card-footer']")).not.toBeNull()
  })

  it("disables the CTA for a source that is already added", () => {
    renderCard({ alreadyAdded: true })
    expect(screen.getByText("Already added")).toBeInTheDocument()
    expect(screen.getByTestId("marketplace-source-preview-add")).toBeDisabled()
  })

  it("disables both actions while the add is in flight", () => {
    renderCard({}, { adding: true })
    expect(screen.getByTestId("marketplace-source-preview-add")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
  })

  it("wires add, cancel and open-repo", () => {
    const { onAdd, onCancel, onOpenRepo } = renderCard()
    fireEvent.click(screen.getByTestId("marketplace-source-preview-add"))
    expect(onAdd).toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }))
    expect(onOpenRepo).toHaveBeenCalledWith("https://github.com/acme/plugins")
  })
})
