/**
 * @jest-environment jsdom
 *
 * Tests for CanvasDocumentRail — exercise the document row's a11y-safe
 * sibling-button structure (the row used to nest a span[role=button] inside
 * a <button>) plus the empty + rename flows.
 */

import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CanvasDocumentRail } from "./canvas-document-rail"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { useProjectStore } from "@/stores/project/project-store"

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

function resetStores() {
  act(() => {
    useCanvasLayoutStore.getState().resetLayout()
    const docs = Object.keys(useArtifactStore.getState().canvasDocuments)
    docs.forEach((id) => useArtifactStore.getState().deleteCanvasDocument(id))
    useArtifactStore.getState().setActiveCanvas(null)
    useProjectStore.setState({ activeProjectId: null })
  })
}

describe("CanvasDocumentRail", () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetStores()
  })

  it("renders the Empty primitive when there are no documents", () => {
    renderWithProviders(<CanvasDocumentRail />)
    expect(screen.getByText(/No documents yet/i)).toBeInTheDocument()
  })

  it("does not nest an interactive element inside another interactive element", () => {
    act(() => {
      useArtifactStore.getState().createCanvasDocument({
        title: "Hello",
        content: "",
        language: "markdown",
        type: "text",
      })
    })
    const { container } = renderWithProviders(<CanvasDocumentRail />)
    // The fix moved the delete control out of the row <button>; no descendant
    // button should sit underneath another button.
    const buttons = container.querySelectorAll("button")
    buttons.forEach((btn) => {
      expect(btn.querySelector("button")).toBeNull()
    })
    // The row should also be a <div role="listitem"> or <li> wrapper, not a button.
    const row = container.querySelector('div[class*="rounded-md"][class*="px-2"]')
    expect(row).toBeTruthy()
    if (row) {
      expect(row.tagName).toBe("DIV")
    }
  })

  it("uses the translated aria-label on the delete control", () => {
    act(() => {
      useArtifactStore.getState().createCanvasDocument({
        title: "Bye",
        content: "",
        language: "markdown",
        type: "text",
      })
    })
    renderWithProviders(<CanvasDocumentRail />)
    // The document title must be interpolated into the aria-label; a missing
    // {name} arg would render the literal placeholder and throw at runtime.
    expect(screen.getByRole("button", { name: "Delete document Bye" })).toBeInTheDocument()
  })

  it("activates the document when the row's select button is clicked", async () => {
    let docId = ""
    act(() => {
      docId = useArtifactStore.getState().createCanvasDocument({
        title: "Alpha",
        content: "",
        language: "markdown",
        type: "text",
      })
    })
    const user = userEvent.setup()
    renderWithProviders(<CanvasDocumentRail />)
    // First clear the active doc so we can observe the click activating it.
    act(() => {
      useArtifactStore.getState().setActiveCanvas(null)
    })
    await user.click(screen.getByText("Alpha"))
    expect(useArtifactStore.getState().activeCanvasId).toBe(docId)
  })

  it("removes the document when the delete control is clicked", async () => {
    act(() => {
      useArtifactStore.getState().createCanvasDocument({
        title: "Doomed",
        content: "",
        language: "markdown",
        type: "text",
      })
    })
    const user = userEvent.setup()
    renderWithProviders(<CanvasDocumentRail />)
    await user.click(screen.getByRole("button", { name: /Delete document/i }))
    expect(Object.values(useArtifactStore.getState().canvasDocuments)).toHaveLength(0)
  })

  it("filters documents by the search box", async () => {
    act(() => {
      const store = useArtifactStore.getState()
      store.createCanvasDocument({
        title: "alpha",
        content: "",
        language: "markdown",
        type: "text",
      })
      store.createCanvasDocument({
        title: "beta",
        content: "",
        language: "markdown",
        type: "text",
      })
    })
    const user = userEvent.setup()
    renderWithProviders(<CanvasDocumentRail />)
    const search = screen.getByPlaceholderText(/Search documents/i)
    await user.type(search, "alpha")
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.queryByText("beta")).not.toBeInTheDocument()
  })

  it("creates a new document via the rail's New button", async () => {
    const user = userEvent.setup()
    renderWithProviders(<CanvasDocumentRail />)
    const newBtn = screen.getByRole("button", { name: /New document/i })
    await user.click(newBtn)
    expect(Object.values(useArtifactStore.getState().canvasDocuments)).toHaveLength(1)
  })

  it("renders the language Badge on each row", () => {
    act(() => {
      useArtifactStore.getState().createCanvasDocument({
        title: "Tagged",
        content: "",
        language: "typescript",
        type: "code",
      })
    })
    const { container } = renderWithProviders(<CanvasDocumentRail />)
    const row = within(container).getByText("Tagged").closest("div")
    expect(row).toBeTruthy()
    expect(screen.getByText("typescript")).toBeInTheDocument()
  })

  it("switches to a flat file-list view showing name.ext when the Files toggle is clicked", async () => {
    act(() => {
      useArtifactStore.getState().createCanvasDocument({
        title: "Report",
        content: "",
        language: "python",
        type: "code",
      })
    })
    const user = userEvent.setup()
    renderWithProviders(<CanvasDocumentRail />)
    // Default (grouped) view shows the bare title + a language badge.
    expect(screen.getByText("Report")).toBeInTheDocument()
    expect(screen.getByText("python")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /^Files$/i }))

    // File-list view shows the filename with extension and drops the badge.
    expect(screen.getByText("Report.py")).toBeInTheDocument()
    expect(screen.queryByText("Report")).not.toBeInTheDocument()
    expect(screen.queryByText("python")).not.toBeInTheDocument()
    expect(useCanvasLayoutStore.getState().railViewMode).toBe("files")
  })

  describe("Sidebar primitive migration", () => {
    it("renders SidebarHeader / SidebarContent / SidebarGroup structural slots", () => {
      const { container } = renderWithProviders(<CanvasDocumentRail />)
      expect(container.querySelector('[data-slot="sidebar-header"]')).toBeTruthy()
      expect(container.querySelector('[data-slot="sidebar-content"]')).toBeTruthy()
      expect(container.querySelectorAll('[data-slot="sidebar-group"]').length).toBeGreaterThan(0)
      expect(container.querySelector('[data-slot="sidebar-separator"]')).toBeTruthy()
    })

    it("emits SidebarMenu and SidebarMenuItem data attributes for each time-bucket", () => {
      act(() => {
        useArtifactStore.getState().createCanvasDocument({
          title: "Today doc",
          content: "",
          language: "markdown",
          type: "text",
        })
      })
      const { container } = renderWithProviders(<CanvasDocumentRail />)
      const menus = container.querySelectorAll('[data-sidebar="menu"]')
      expect(menus.length).toBeGreaterThan(0)
      const items = container.querySelectorAll('[data-sidebar="menu-item"]')
      expect(items.length).toBeGreaterThan(0)
      // Each item must be an <li> so the menu/<ul> structure stays valid.
      items.forEach((item) => expect(item.tagName).toBe("LI"))
    })

    it("renders the SidebarGroupLabel for the time bucket containing recent docs", () => {
      act(() => {
        useArtifactStore.getState().createCanvasDocument({
          title: "Recently",
          content: "",
          language: "markdown",
          type: "text",
        })
      })
      const { container } = renderWithProviders(<CanvasDocumentRail />)
      const labels = container.querySelectorAll('[data-slot="sidebar-group-label"]')
      expect(labels.length).toBeGreaterThan(0)
      const labelTexts = Array.from(labels).map((el) => el.textContent ?? "")
      expect(labelTexts.some((t) => /today/i.test(t))).toBe(true)
    })

    it("renders without a SidebarProvider — does not throw, no console error", () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      try {
        act(() => {
          useArtifactStore.getState().createCanvasDocument({
            title: "ProviderFree",
            content: "",
            language: "markdown",
            type: "text",
          })
        })
        expect(() => renderWithProviders(<CanvasDocumentRail />)).not.toThrow()
        // Regression guard: SidebarMenuButton would have logged
        // "useSidebar must be used within a SidebarProvider". We must never
        // import that primitive into the rail.
        const sidebarProviderErrors = errorSpy.mock.calls.filter((args) =>
          args.some((arg) => typeof arg === "string" && /SidebarProvider/.test(arg))
        )
        expect(sidebarProviderErrors.length).toBe(0)
      } finally {
        errorSpy.mockRestore()
      }
    })
  })
})

describe("CanvasDocumentRail — workspace isolation", () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetStores()
  })

  afterEach(() => {
    act(() => {
      useProjectStore.setState({ activeProjectId: null })
    })
  })

  function seedIn(projectId: string, title: string) {
    act(() => {
      useProjectStore.setState({ activeProjectId: projectId })
      useArtifactStore.getState().createCanvasDocument({
        title,
        content: title,
        language: "markdown",
        type: "text",
      })
    })
  }

  it("lists only the active workspace's documents", () => {
    seedIn("ws-a", "AlphaDoc")
    seedIn("ws-b", "BetaDoc")
    act(() => {
      useProjectStore.setState({ activeProjectId: "ws-a" })
    })

    renderWithProviders(<CanvasDocumentRail />)

    expect(screen.getByText("AlphaDoc")).toBeInTheDocument()
    expect(screen.queryByText("BetaDoc")).not.toBeInTheDocument()
  })

  it("switching workspace never reveals the other workspace's documents", () => {
    seedIn("ws-a", "AlphaDoc")
    seedIn("ws-b", "BetaDoc")
    act(() => {
      useProjectStore.setState({ activeProjectId: "ws-a" })
    })

    renderWithProviders(<CanvasDocumentRail />)
    expect(screen.getByText("AlphaDoc")).toBeInTheDocument()

    act(() => {
      useProjectStore.setState({ activeProjectId: "ws-b" })
    })

    expect(screen.getByText("BetaDoc")).toBeInTheDocument()
    expect(screen.queryByText("AlphaDoc")).not.toBeInTheDocument()
  })
})
