/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

// Namespaced keys so a test can tell which vocabulary labelled an option.
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (ns?: string) => (key: string) =>
    ns && ns !== "plugins.filterSheet" ? `${ns}.${key}` : key,
}))

let mockRows: PluginRow[] = []
jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => ({ all: mockRows }),
}))

import { collectPluginKeywords, PluginFilterSheet } from "./plugin-filter-sheet"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

function row(id: string, keywords?: unknown): PluginRow {
  return {
    id,
    name: id,
    version: "1.0.0",
    status: "installed",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "",
    manifest: keywords === undefined ? {} : { keywords },
    createdAt: 0,
    updatedAt: 0,
  }
}

// Radix Select measures the trigger and scrolls items into view.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
  Element.prototype.hasPointerCapture = jest.fn(() => false)
  Element.prototype.releasePointerCapture = jest.fn()
})

beforeEach(() => {
  mockRows = []
  usePluginsStore.setState({
    filterSheetOpen: true,
    filters: DEFAULT_PLUGIN_FILTERS,
  })
})

describe("PluginFilterSheet", () => {
  it("does not render when filterSheetOpen is false", () => {
    usePluginsStore.setState({ filterSheetOpen: false })
    const { container } = render(<PluginFilterSheet />)
    // The Sheet still mounts a portal but its content stays out of the DOM.
    expect(container.querySelector("[role='dialog']")).toBeNull()
  })

  it("insets the filter fields from the sheet edge", () => {
    render(<PluginFilterSheet />)
    expect(screen.getByTestId("plugin-filter-sheet-body")).toHaveClass("px-4")
  })

  it("renders fields for query / capability / permission / source / status", () => {
    render(<PluginFilterSheet />)
    expect(screen.getByText("query")).toBeInTheDocument()
    expect(screen.getByText("capability")).toBeInTheDocument()
    expect(screen.getByText("permission")).toBeInTheDocument()
    expect(screen.getByText("source")).toBeInTheDocument()
    expect(screen.getByText("status")).toBeInTheDocument()
  })

  it("renders each permission option once when permission groups overlap", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      render(<PluginFilterSheet />)
      expect(
        errorSpy.mock.calls.some((args) =>
          args.some((arg) => String(arg).includes("Encountered two children with the same key"))
        )
      ).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("no longer renders the sort control (moved to the library header)", () => {
    render(<PluginFilterSheet />)
    expect(screen.queryByText("sort")).not.toBeInTheDocument()
  })

  it("renders signedOnly + hasUpdate switches", () => {
    render(<PluginFilterSheet />)
    expect(screen.getByText("signedOnly")).toBeInTheDocument()
    expect(screen.getByText("hasUpdate")).toBeInTheDocument()
  })

  it("typing in the query input persists into the store", () => {
    render(<PluginFilterSheet />)
    const input = screen.getByPlaceholderText("queryPlaceholder")
    fireEvent.change(input, { target: { value: "alpha" } })
    expect(usePluginsStore.getState().filters.query).toBe("alpha")
  })

  it("reset button restores default filters", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, query: "x", signedOnly: true },
    })
    render(<PluginFilterSheet />)
    fireEvent.click(screen.getByText("reset"))
    expect(usePluginsStore.getState().filters).toEqual(DEFAULT_PLUGIN_FILTERS)
  })
})

describe("PluginFilterSheet option labels", () => {
  async function openSelect(name: string) {
    const user = userEvent.setup()
    const field = screen.getByText(name).parentElement!
    await user.click(within(field).getByRole("combobox"))
    return screen.getByRole("listbox")
  }

  it("labels status options with the status pill's words and offers only user-meaningful ones", async () => {
    render(<PluginFilterSheet />)
    const listbox = await openSelect("status")
    const options = within(listbox)
      .getAllByRole("option")
      .map((o) => o.textContent)
    expect(options).toEqual([
      "any",
      "plugins.card.status.enabled",
      "plugins.card.status.disabled",
      "plugins.card.status.error",
    ])
  })

  it("keeps an unoffered status visible as the current value", () => {
    usePluginsStore.setState({ filters: { ...DEFAULT_PLUGIN_FILTERS, status: "installed" } })
    render(<PluginFilterSheet />)
    const field = screen.getByText("status").parentElement!
    expect(within(field).getByRole("combobox").textContent).toContain("installed")
  })

  it("labels sources with the source badge's words", async () => {
    render(<PluginFilterSheet />)
    const listbox = await openSelect("source")
    expect(within(listbox).getByText("plugins.source.builtin")).toBeInTheDocument()
    expect(within(listbox).getByText("plugins.source.dev")).toBeInTheDocument()
    expect(within(listbox).queryByText("builtin")).not.toBeInTheDocument()
  })

  it("describes permissions and keeps the id beside the description", async () => {
    render(<PluginFilterSheet />)
    const listbox = await openSelect("permission")
    const option = within(listbox)
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("clipboard:read"))!
    // The mock translator has no `has()`, so the guard's English sentence is
    // the description; either way the option is more than the bare id.
    expect(option.textContent).not.toBe("clipboard:read")
    expect(option.querySelector("code")?.textContent).toBe("clipboard:read")
  })
})

describe("PluginFilterSheet tag field", () => {
  it("shows the current tag and clears it through Any", async () => {
    mockRows = [row("a", ["Productivity", "ai"]), row("b", ["productivity"])]
    usePluginsStore.setState({ filters: { ...DEFAULT_PLUGIN_FILTERS, tag: "productivity" } })
    render(<PluginFilterSheet />)
    const trigger = screen.getByTestId("plugin-filter-sheet-tag")
    expect(trigger.textContent).toContain("Productivity")
    const user = userEvent.setup()
    await user.click(trigger)
    await user.click(within(screen.getByRole("listbox")).getByText("any"))
    expect(usePluginsStore.getState().filters.tag).toBeNull()
  })

  it("sets a tag from the installed plugins' keywords", async () => {
    mockRows = [row("a", ["ai"])]
    render(<PluginFilterSheet />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId("plugin-filter-sheet-tag"))
    await user.click(within(screen.getByRole("listbox")).getByText("ai"))
    expect(usePluginsStore.getState().filters.tag).toBe("ai")
  })

  it("still shows a tag no installed plugin carries", () => {
    usePluginsStore.setState({ filters: { ...DEFAULT_PLUGIN_FILTERS, tag: "gone" } })
    render(<PluginFilterSheet />)
    expect(screen.getByTestId("plugin-filter-sheet-tag").textContent).toContain("gone")
  })

  it("says so when no plugin declares keywords", () => {
    render(<PluginFilterSheet />)
    expect(screen.getByText("tagNone")).toBeInTheDocument()
  })
})

describe("collectPluginKeywords", () => {
  it("dedupes case-insensitively, drops junk and sorts", () => {
    expect(
      collectPluginKeywords([
        row("a", ["Zeta", "alpha", " ", 3]),
        row("b", ["ALPHA", "beta"]),
        row("c", "not-an-array"),
        row("d"),
      ])
    ).toEqual(["alpha", "beta", "Zeta"])
  })
})
