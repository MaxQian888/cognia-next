import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { PluginMarketplaceSourcesDialog } from "./plugin-marketplace-sources-dialog"
import type { PluginMarketplaceSourceRow } from "@/lib/db/plugin-types"

const preview = jest.fn()
const commitPreview = jest.fn()
const add = jest.fn()
const remove = jest.fn()
const refresh = jest.fn()
const refreshSource = jest.fn()
let sources: PluginMarketplaceSourceRow[] = []
let syncingIds: Set<string> = new Set()
jest.mock("@/hooks/plugins/use-github-marketplace-sources", () => ({
  useGithubMarketplaceSources: () => ({
    sources,
    syncingIds,
    preview,
    commitPreview,
    add,
    remove,
    refresh,
    refreshSource,
    entries: [],
    errors: [],
    loading: false,
  }),
}))

const openUrl = jest.fn()
jest.mock("@/lib/native/opener", () => ({ openUrl: (...a: unknown[]) => openUrl(...a) }))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

jest.mock("@/lib/plugin/package/recommended-marketplace-sources", () => ({
  RECOMMENDED_MARKETPLACE_SOURCES: [
    { repoRef: "beta/labs", name: "Beta Labs", description: "Community picks." },
  ],
}))

const CATALOG = {
  id: "acme/plugins",
  name: "Acme Plugins",
  owner: "Acme Labs",
  catalogPath: "marketplace.json",
  repoUrl: "https://github.com/acme/plugins",
  entries: [
    { id: "acme/plugins:web-tools", name: "web-tools", version: "1.2.0", description: "Fetch." },
  ],
}

function row(over: Partial<PluginMarketplaceSourceRow> = {}): PluginMarketplaceSourceRow {
  return { id: "acme/plugins", repoRef: "acme/plugins", name: "Acme Plugins", addedAt: 1, ...over }
}

function renderDialog() {
  return render(<PluginMarketplaceSourcesDialog open onOpenChange={jest.fn()} />)
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Marketplace repository"), { target: { value } })
}

describe("PluginMarketplaceSourcesDialog", () => {
  beforeEach(() => {
    preview.mockReset()
    commitPreview.mockReset().mockResolvedValue(undefined)
    add.mockReset()
    remove.mockReset()
    refresh.mockReset().mockResolvedValue(undefined)
    refreshSource.mockReset()
    openUrl.mockReset()
    toastError.mockReset()
    sources = []
    syncingIds = new Set()
  })

  it("validates an empty input before spending a request", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("marketplace-source-preview-submit"))
    expect(screen.getByRole("alert")).toHaveTextContent("Please enter a repository.")
    expect(preview).not.toHaveBeenCalled()
  })

  it("previews the catalog, then commits it without re-fetching", async () => {
    preview.mockResolvedValue(CATALOG)
    renderDialog()
    type("acme/plugins")
    fireEvent.click(screen.getByTestId("marketplace-source-preview-submit"))

    await screen.findByTestId("marketplace-source-preview")
    expect(screen.getByText("Acme Plugins")).toBeInTheDocument()
    expect(screen.getByText("web-tools")).toBeInTheDocument()
    expect(commitPreview).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("marketplace-source-preview-add"))
    await waitFor(() => expect(commitPreview).toHaveBeenCalledWith("acme/plugins", CATALOG))
    // Exactly one network call for the whole add.
    expect(preview).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect((screen.getByLabelText("Marketplace repository") as HTMLInputElement).value).toBe("")
    )
  })

  it("offers no canonical hint for text that isn't a repository yet", () => {
    renderDialog()
    type("acme")
    expect(screen.queryByText(/^Will add/)).not.toBeInTheDocument()
  })

  it("keeps a pinned ref in the canonical hint", () => {
    renderDialog()
    type("https://github.com/acme/plugins/tree/next/packages")
    expect(screen.getByText("Will add acme/plugins@next")).toBeInTheDocument()
  })

  it("shows a non-Error preview rejection rather than [object Object]", async () => {
    preview.mockRejectedValue("socket hang up")
    renderDialog()
    type("acme/plugins")
    fireEvent.click(screen.getByTestId("marketplace-source-preview-submit"))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not read this repository: socket hang up"
      )
    )
  })

  it("surfaces a failure to persist the previewed source", async () => {
    preview.mockResolvedValue(CATALOG)
    commitPreview.mockRejectedValue(new Error("db closed"))
    renderDialog()
    type("acme/plugins")
    fireEvent.click(screen.getByTestId("marketplace-source-preview-submit"))
    await screen.findByTestId("marketplace-source-preview")

    fireEvent.click(screen.getByTestId("marketplace-source-preview-add"))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Could not add source: db closed")
    )
  })

  it("surfaces a preview failure", async () => {
    preview.mockRejectedValue(new Error("no marketplace.json found"))
    renderDialog()
    type("acme/empty")
    fireEvent.click(screen.getByTestId("marketplace-source-preview-submit"))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not read this repository: no marketplace.json found"
      )
    )
    expect(commitPreview).not.toHaveBeenCalled()
  })

  // A preview left on screen while the text changes would let the user confirm
  // a marketplace they are no longer looking at.
  it("drops the preview when the reference is edited", async () => {
    preview.mockResolvedValue(CATALOG)
    renderDialog()
    type("acme/plugins")
    fireEvent.click(screen.getByTestId("marketplace-source-preview-submit"))
    await screen.findByTestId("marketplace-source-preview")

    type("acme/other")
    expect(screen.queryByTestId("marketplace-source-preview")).not.toBeInTheDocument()
  })

  it("marks a preview of an already-saved source as added", async () => {
    sources = [row()]
    preview.mockResolvedValue(CATALOG)
    renderDialog()
    type("acme/plugins")
    fireEvent.click(screen.getByTestId("marketplace-source-preview-submit"))
    await screen.findByTestId("marketplace-source-preview")
    expect(screen.getByTestId("marketplace-source-preview-add")).toBeDisabled()
  })

  it("shows a healthy row's plugin count", () => {
    sources = [row({ pluginCount: 8, lastSyncedAt: 1_700_000_000_000 })]
    renderDialog()
    expect(screen.getByText(/8 plugins/)).toBeInTheDocument()
  })

  // A source that synced yesterday and failed this morning is failing; leading
  // with yesterday's healthy count would bury what the user has to act on.
  it("lets a stored error outrank an older successful sync", () => {
    sources = [row({ pluginCount: 8, lastSyncedAt: 1_700_000_000_000, lastError: "API 403" })]
    renderDialog()
    expect(screen.getByText("Sync failed")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("API 403")
  })

  it("reads a row with no health fields as never synced", () => {
    sources = [row()]
    renderDialog()
    expect(screen.getByText("Not synced yet")).toBeInTheDocument()
  })

  it("reflects an in-flight per-source refresh", () => {
    sources = [row()]
    syncingIds = new Set(["acme/plugins"])
    renderDialog()
    expect(screen.getByText("Syncing…")).toBeInTheDocument()
  })

  it("wires per-source refresh, refresh-all and open-repo", async () => {
    sources = [row()]
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: "Refresh Acme Plugins" }))
    expect(refreshSource).toHaveBeenCalledWith("acme/plugins")

    fireEvent.click(screen.getByTestId("marketplace-sources-refresh-all"))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId("marketplace-sources-refresh-all")).toBeEnabled())

    fireEvent.click(screen.getAllByRole("button", { name: "Open on GitHub" })[0])
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/plugins")
  })

  // A row whose stored reference no longer parses still has to render — the
  // only thing it loses is a precise link target.
  it("falls back to github.com for an unparseable stored reference", () => {
    sources = [row({ repoRef: "not a repo" })]
    renderDialog()
    fireEvent.click(screen.getAllByRole("button", { name: "Open on GitHub" })[0])
    expect(openUrl).toHaveBeenCalledWith("https://github.com")
  })

  it("removes a source after the confirmation", () => {
    sources = [row()]
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Remove Acme Plugins" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove source" }))
    expect(remove).toHaveBeenCalledWith("acme/plugins")
  })

  it("adds a curated source in one click", async () => {
    add.mockResolvedValue(undefined)
    renderDialog()
    fireEvent.click(
      screen.getByTestId("marketplace-recommended-beta/labs").querySelector("button")!
    )
    await waitFor(() => expect(add).toHaveBeenCalledWith("beta/labs"))
  })

  // This path has no preview card, so the failure has nowhere inline to live.
  it("toasts when a curated add fails", async () => {
    add.mockRejectedValue(new Error("rate limited"))
    renderDialog()
    fireEvent.click(
      screen.getByTestId("marketplace-recommended-beta/labs").querySelector("button")!
    )
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not add source: rate limited")
    )
  })
})
