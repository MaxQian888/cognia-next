/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useFormatter: () => ({
    dateTime: (date: Date) => `fmt:${date.toISOString().slice(0, 10)}`,
  }),
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    if (vars && typeof vars.version === "string") return `${key}:${vars.version}`
    if (vars && typeof vars.date === "string") return `${key}:${vars.date}`
    return key
  },
}))

let mockPlugin: PluginRow | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
}))
jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(),
}))

// In-memory PluginManager store — drives the new Verification card. Default
// to no snapshot so existing tests still see the original Overview shape.
let mockPluginInMemory:
  | {
      status?: string
      verificationSnapshot?: unknown
      lastKnownGoodVerification?: unknown
    }
  | undefined
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: (selector: (s: unknown) => unknown) =>
    selector({ plugins: mockPluginInMemory ? { alpha: mockPluginInMemory } : {} }),
}))

// The raw-manifest viewer reuses the chat CodeBlock (async Shiki). Stub it so
// the dialog test stays synchronous and can assert the props it receives.
const codeBlockPropsMock = jest.fn()
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: (props: { code: string; language?: string }) => {
    codeBlockPropsMock(props)
    return <pre data-testid="manifest-code">{props.code}</pre>
  },
}))

// The dependency panel queries the plugin table on its own; its rows and
// installed-state logic are pinned in its own test. Here only the wiring
// matters: the overview hands it a way to open a dependency's detail.
jest.mock("../_shared/plugin-dependency-panel", () => ({
  PluginDependencyPanel: ({
    onOpenDependency,
  }: {
    onOpenDependency?: (pluginId: string) => void
  }) => (
    <button type="button" data-testid="dep-open-beta" onClick={() => onOpenDependency?.("beta")}>
      beta
    </button>
  ),
}))

import { usePluginsStore } from "@/stores/plugins"
import { PluginDetailOverview } from "./plugin-detail-overview"

function makePlugin(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "alpha",
    name: "Alpha",
    version: "1.2.3",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/plugins/alpha",
    manifest: {
      id: "alpha",
      description: "Alpha plugin",
      author: "Team",
      license: "MIT",
      homepage: "https://example.com",
    },
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 1, 1),
    ...overrides,
  }
}

describe("PluginDetailOverview", () => {
  beforeEach(() => {
    mockPlugin = makePlugin()
    mockPluginInMemory = undefined
    usePluginsStore.setState({ rollbackTarget: null, detailOverviewView: "info" })
  })

  it("renders core meta rows from the manifest", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("MIT")).toBeInTheDocument()
    // Scheme dropped for the narrow column; the link keeps the full URL.
    expect(screen.getByRole("link", { name: "example.com" })).toHaveAttribute(
      "href",
      "https://example.com"
    )
  })

  it("leaves the version to the header instead of repeating it", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.queryByText("metaVersion")).toBeNull()
  })

  it("localizes source, type and dates instead of printing stored values", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByText("marketplace")).toBeInTheDocument() // plugins.source:marketplace
    expect(screen.getByText("pluginType.frontend")).toBeInTheDocument()
    expect(screen.getByText("fmt:2026-01-01")).toBeInTheDocument()
    expect(screen.getByText("fmt:2026-02-01")).toBeInTheDocument()
  })

  it("never turns a non-http homepage into a link", () => {
    mockPlugin = makePlugin({
      manifest: { id: "alpha", homepage: "javascript:alert(1)" } as PluginRow["manifest"],
    })
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument()
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("renders the README in the flow, with no nested scroller", () => {
    mockPlugin = makePlugin({ readme: "# Hello" })
    render(<PluginDetailOverview pluginId="alpha" />)
    const readme = screen.getByTestId("plugin-detail-readme")
    expect(readme.innerHTML).not.toMatch(/max-h-\[|overflow-y-auto/)
  })

  it("says when there is no README", () => {
    mockPlugin = makePlugin({
      readme: undefined,
      manifest: { id: "alpha" } as PluginRow["manifest"],
    })
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByTestId("plugin-detail-no-readme")).toHaveTextContent("noReadme")
  })

  it("says what a VS Code extension uses that Cognia does not provide", () => {
    mockPlugin = makePlugin({
      type: "vscode-extension",
      manifest: {
        id: "alpha",
        type: "vscode-extension",
        vscodeExtension: { unsupportedContributions: ["keybindings"] },
      } as unknown as PluginRow["manifest"],
    })
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByTestId("plugin-vscode-compat-keybindings")).toBeInTheDocument()
  })

  it("shows no compatibility section for other plugins", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.queryByTestId("plugin-vscode-compat-section")).not.toBeInTheDocument()
  })

  it("shows the last error as a ruled callout, not a box", () => {
    mockPlugin = makePlugin({ error: "boom", status: "error" })
    render(<PluginDetailOverview pluginId="alpha" />)
    const callout = screen.getByTestId("plugin-detail-last-error")
    expect(callout).toHaveTextContent("metaError")
    expect(callout).toHaveTextContent("boom")
    expect(callout).toHaveAttribute("role", "alert")
    expect(callout.className).toContain("border-l-2")
    expect(callout.className).not.toContain("rounded")
  })

  it("offers no unconditional Rollback button (the header menu gates it)", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.queryByLabelText("rollbackAria:Alpha")).toBeNull()
  })

  it("swaps the details body for the raw manifest in place, without a dialog", () => {
    codeBlockPropsMock.mockClear()
    const { rerender } = render(<PluginDetailOverview pluginId="alpha" />)
    // Details is the landing view, so the meta list is what renders first.
    expect(screen.getByText("metaId")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-detail-raw-manifest")).not.toBeInTheDocument()

    // The header's "View raw manifest" writes the store.
    act(() => usePluginsStore.getState().openDetailManifest())
    rerender(<PluginDetailOverview pluginId="alpha" />)

    expect(screen.getByTestId("plugin-detail-raw-manifest")).toBeInTheDocument()
    // The manifest is handed to the CodeBlock as JSON for syntax highlighting.
    expect(codeBlockPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({ language: "json", filename: "alpha.json" })
    )
    expect(screen.getByTestId("manifest-code").textContent).toContain('"alpha"')
    // In place means the details it replaced are gone, not covered by a modal.
    expect(screen.queryByText("metaId")).not.toBeInTheDocument()
  })

  it("returns to the details view from the raw manifest", () => {
    usePluginsStore.setState({ detailOverviewView: "manifest" })
    render(<PluginDetailOverview pluginId="alpha" />)
    fireEvent.click(screen.getByTestId("plugin-detail-back-to-info"))
    expect(screen.getByText("metaId")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-detail-raw-manifest")).not.toBeInTheDocument()
  })

  it("opens an installed dependency's own detail", () => {
    mockPlugin = makePlugin({
      manifest: { id: "alpha", dependencies: { beta: "^1.0.0" } } as PluginRow["manifest"],
    })
    render(<PluginDetailOverview pluginId="alpha" />)
    fireEvent.click(screen.getByTestId("dep-open-beta"))
    expect(usePluginsStore.getState().detailPluginId).toBe("beta")
  })

  it("hides the Verification card when no snapshot exists in memory", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.queryByTestId("plugin-detail-verification-card")).not.toBeInTheDocument()
  })

  it("renders the Verification card when a snapshot is available", () => {
    mockPluginInMemory = {
      verificationSnapshot: {
        pluginId: "alpha",
        source: "marketplace",
        status: "enabled",
        verificationStage: "activation",
        lastVerifiedAction: "enable",
        lastVerifiedAt: "2026-05-22T00:00:00Z",
        lastSuccessfulAt: "2026-05-22T00:00:00Z",
        resolvedVersion: "1.2.3",
        diagnostics: [],
      },
    }
    render(<PluginDetailOverview pluginId="alpha" />)
    const card = screen.getByTestId("plugin-detail-verification-card")
    expect(card).toBeInTheDocument()
    expect(card.textContent).toContain("title")
    // Snapshot status and stage, by their labels.
    expect(card.textContent).toContain("runtimeStatus.enabled")
    expect(card.textContent).toContain("stage.activation")
    // Dates through the locale formatter, not raw ISO strings.
    expect(card.textContent).toContain("lastSuccessfulAt:fmt:2026-05-22")
    expect(card.textContent).not.toContain("2026-05-22T00:00:00Z")
  })

  it("surfaces a rollback CTA when current and last-good diverge", () => {
    mockPluginInMemory = {
      verificationSnapshot: {
        pluginId: "alpha",
        source: "marketplace",
        status: "error",
        verificationStage: "activation",
        lastVerifiedAction: "enable",
        lastVerifiedAt: "2026-05-22T00:00:00Z",
        lastFailureAt: "2026-05-22T00:00:00Z",
        resolvedVersion: "1.3.0",
        diagnostics: [],
      },
      lastKnownGoodVerification: {
        pluginId: "alpha",
        source: "marketplace",
        status: "enabled",
        verificationStage: "activation",
        lastVerifiedAction: "enable",
        lastVerifiedAt: "2026-05-01T00:00:00Z",
        lastSuccessfulAt: "2026-05-01T00:00:00Z",
        resolvedVersion: "1.2.3",
        diagnostics: [],
      },
    }
    render(<PluginDetailOverview pluginId="alpha" />)
    const card = screen.getByTestId("plugin-detail-verification-card")
    expect(card).toBeInTheDocument()
    // Rollback CTA renders within the Verification card.
    expect(card.textContent).toContain("rollbackTo")
    expect(card.textContent).toContain("1.2.3")
  })
})

/**
 * `manifest.screenshots` and `manifest.keywords` existed in the manifest type
 * with no renderer anywhere, and `PluginFilters.tag` was declared and applied
 * by nothing. The chips are what tie the last two together.
 */
describe("manifest metadata that had no renderer", () => {
  const renderOverview = (manifestExtras: Record<string, unknown>) => {
    mockPlugin = makePlugin({
      manifest: { ...makePlugin().manifest, ...manifestExtras } as PluginRow["manifest"],
    })
    usePluginsStore.setState({ filters: { ...usePluginsStore.getState().filters, tag: null } })
    return render(<PluginDetailOverview pluginId="alpha" />)
  }

  it("renders the screenshot gallery when the manifest ships previews", () => {
    renderOverview({ screenshots: ["https://example.test/a.png"] })
    expect(screen.getByTestId("plugin-screenshot-gallery")).toBeInTheDocument()
  })

  it("renders no gallery block when there are no previews", () => {
    renderOverview({})
    expect(screen.queryByTestId("plugin-screenshot-gallery")).toBeNull()
  })

  it("renders keyword chips and writes the tag facet when one is clicked", () => {
    renderOverview({ keywords: ["ocr", "screenshot"] })
    const chips = screen.getByTestId("plugin-keyword-chips")
    expect(chips).toHaveTextContent("ocr")
    fireEvent.click(screen.getByText("ocr"))
    expect(usePluginsStore.getState().filters.tag).toBe("ocr")
  })

  it("tells a covering host to step aside after a keyword filter", () => {
    mockPlugin = makePlugin({
      manifest: { ...makePlugin().manifest, keywords: ["ocr"] } as PluginRow["manifest"],
    })
    const onFilterApplied = jest.fn()
    render(<PluginDetailOverview pluginId="alpha" onFilterApplied={onFilterApplied} />)
    fireEvent.click(screen.getByText("ocr"))
    expect(onFilterApplied).toHaveBeenCalled()
  })

  it("renders no keyword block when the manifest advertises none", () => {
    renderOverview({})
    expect(screen.queryByTestId("plugin-keyword-chips")).toBeNull()
  })
})

describe("status row", () => {
  beforeEach(() => {
    mockPluginInMemory = undefined
  })

  // The row's `status` is written at discovery; enabling a plugin changes the
  // runtime store and `enabled`, not that column, so it used to read
  // "discovered" beside an "Enabled" switch.
  it("shows the runtime status over the row's discovery-time value", () => {
    mockPlugin = makePlugin({ status: "discovered" })
    mockPluginInMemory = { status: "enabled" }
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByText("runtimeStatus.enabled")).toBeInTheDocument()
    expect(screen.queryByText("runtimeStatus.discovered")).not.toBeInTheDocument()
  })

  it("falls back to the row's status, labelled, when the runtime has no entry", () => {
    mockPlugin = makePlugin({ status: "discovered" })
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByText("runtimeStatus.discovered")).toBeInTheDocument()
  })

  it("prints a status it does not know as stored", () => {
    mockPlugin = makePlugin({ status: "from-the-future" as never })
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByText("from-the-future")).toBeInTheDocument()
  })
})
