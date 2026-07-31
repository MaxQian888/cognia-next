import { render, screen, fireEvent } from "@testing-library/react"

import { PluginMarketplaceSourceRow } from "./source-row"
import type { MarketplaceSourceItem, SourceSyncState } from "./types"

function renderRow(sync: SourceSyncState) {
  const source: MarketplaceSourceItem = {
    id: "acme/plugins",
    name: "Acme Plugins",
    repoRef: "github.com/acme/plugins",
    repoUrl: "https://github.com/acme/plugins",
    sync,
  }
  const onRefresh = jest.fn()
  const onRemove = jest.fn()
  const onOpenRepo = jest.fn()
  render(
    <PluginMarketplaceSourceRow
      source={source}
      onRefresh={onRefresh}
      onRemove={onRemove}
      onOpenRepo={onOpenRepo}
    />
  )
  return { onRefresh, onRemove, onOpenRepo }
}

describe("PluginMarketplaceSourceRow", () => {
  it("shows plugin count and last sync when healthy", () => {
    renderRow({ kind: "ok", pluginCount: 8, lastSyncedAt: 1_700_000_000_000 })
    expect(screen.getByText(/8 plugins/)).toBeInTheDocument()
    expect(screen.getByTestId("marketplace-source-status-ok")).toBeInTheDocument()
  })

  it("distinguishes never-synced from zero plugins", () => {
    renderRow({ kind: "never" })
    expect(screen.getByText("Not synced yet")).toBeInTheDocument()
    expect(screen.queryByText(/no plugins/)).not.toBeInTheDocument()
  })

  it("disables refresh while syncing", () => {
    const { onRefresh } = renderRow({ kind: "syncing" })
    expect(screen.getByText("Syncing…")).toBeInTheDocument()
    const refresh = screen.getByRole("button", { name: "Refresh Acme Plugins" })
    expect(refresh).toBeDisabled()
    fireEvent.click(refresh)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  // The whole point of the health line: a failed sync used to be invisible.
  it("surfaces a failed sync with its message and a retry", () => {
    const { onRefresh } = renderRow({ kind: "error", message: "GitHub API 403" })
    expect(screen.getByText("Sync failed")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub API 403")

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRefresh).toHaveBeenCalledWith("acme/plugins")
  })

  it("still shows when a failing source last succeeded", () => {
    renderRow({ kind: "error", message: "boom", lastSyncedAt: 1_700_000_000_000 })
    expect(screen.getByText(/Synced /)).toBeInTheDocument()
  })

  it("confirms removal and says installed plugins survive it", () => {
    const { onRemove } = renderRow({ kind: "ok", pluginCount: 1, lastSyncedAt: 1 })
    fireEvent.click(screen.getByRole("button", { name: "Remove Acme Plugins" }))

    expect(screen.getByText("Remove Acme Plugins?")).toBeInTheDocument()
    expect(screen.getByText(/stay installed and keep working/i)).toBeInTheDocument()
    expect(onRemove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Remove source" }))
    expect(onRemove).toHaveBeenCalledWith("acme/plugins")
  })

  it("opens the repository", () => {
    const { onOpenRepo } = renderRow({ kind: "never" })
    fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }))
    expect(onOpenRepo).toHaveBeenCalledWith("https://github.com/acme/plugins")
  })
})
