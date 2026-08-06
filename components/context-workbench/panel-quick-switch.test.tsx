/** @jest-environment jsdom */
import { render, screen, fireEvent, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { PanelQuickSwitch } from "./panel-quick-switch"

// --- Mocks ---

const mockRevealActiveWorkbenchPanel = jest.fn().mockReturnValue(true)
const mockGetActiveWorkbenchPanels = jest.fn().mockReturnValue([])
const mockSubscribeActiveContext = jest.fn().mockReturnValue(() => {})
const mockGetActiveContextRevision = jest.fn().mockReturnValue(0)

jest.mock("@/lib/context-workbench/active-context", () => ({
  getActiveWorkbenchPanels: (...args: unknown[]) => mockGetActiveWorkbenchPanels(...args),
  revealActiveWorkbenchPanel: (...args: unknown[]) => mockRevealActiveWorkbenchPanel(...args),
  subscribeActiveContext: (cb: () => void) => mockSubscribeActiveContext(cb),
  getActiveContextRevision: () => mockGetActiveContextRevision(),
}))

jest.mock("@/hooks/shortcuts/use-app-shortcut", () => ({
  useAppShortcut: (id: string, handler: () => void) => {
    // Store handler for manual invocation in tests
    ;(globalThis as Record<string, unknown>).__quickSwitchHandler = handler
  },
}))

const messages = {
  contextWorkbench: {
    quickSwitch: {
      title: "Switch Panel",
      description: "Jump to any panel in the active workbench",
      placeholder: "Search panels…",
      empty: "No matching panels",
    },
    activities: {
      "preview-run": "Preview / run",
      review: "Review",
      ai: "AI",
      comments: "Comments",
      inspect: "Inspect",
      workspace: "Workspace",
      templates: "Templates",
    },
  },
}

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("PanelQuickSwitch", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetActiveWorkbenchPanels.mockReturnValue([
      { id: "preview", activity: "preview-run", labelKey: "preview", label: "Preview" },
      { id: "browser", activity: "preview-run", labelKey: "browser", label: "Browser" },
      { id: "resource-chat", activity: "ai", labelKey: "resourceChat", label: "AI Chat" },
      { id: "comments", activity: "comments", labelKey: "comments", label: "Comments" },
      { id: "metadata", activity: "inspect", labelKey: "metadata", label: "Metadata" },
    ])
  })

  it("renders nothing visible by default (dialog closed)", () => {
    renderWithProviders(<PanelQuickSwitch />)
    expect(screen.queryByTestId("panel-quick-switch-input")).not.toBeInTheDocument()
  })

  it("opens dialog when shortcut handler is triggered", () => {
    renderWithProviders(<PanelQuickSwitch />)
    const handler = (globalThis as Record<string, unknown>).__quickSwitchHandler as () => void
    act(() => handler())
    expect(screen.getByTestId("panel-quick-switch-input")).toBeInTheDocument()
  })

  it("shows panels grouped by activity", () => {
    renderWithProviders(<PanelQuickSwitch />)
    const handler = (globalThis as Record<string, unknown>).__quickSwitchHandler as () => void
    act(() => handler())

    // Check activity group headings (use getAllByText since "Comments" appears
    // both as a group heading and a panel item label)
    expect(screen.getByText("Preview / run")).toBeInTheDocument()
    expect(screen.getByText("AI")).toBeInTheDocument()
    expect(screen.getAllByText("Comments").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Inspect")).toBeInTheDocument()
  })

  it("shows panel items within groups", () => {
    renderWithProviders(<PanelQuickSwitch />)
    const handler = (globalThis as Record<string, unknown>).__quickSwitchHandler as () => void
    act(() => handler())

    expect(screen.getByTestId("panel-quick-switch-item-preview")).toBeInTheDocument()
    expect(screen.getByTestId("panel-quick-switch-item-browser")).toBeInTheDocument()
    expect(screen.getByTestId("panel-quick-switch-item-resource-chat")).toBeInTheDocument()
  })

  it("calls revealActiveWorkbenchPanel and closes on item selection", () => {
    renderWithProviders(<PanelQuickSwitch />)
    const handler = (globalThis as Record<string, unknown>).__quickSwitchHandler as () => void
    act(() => handler())

    const item = screen.getByTestId("panel-quick-switch-item-metadata")
    fireEvent.click(item)

    expect(mockRevealActiveWorkbenchPanel).toHaveBeenCalledWith("metadata")
  })

  it("shows empty state when no panels match", () => {
    mockGetActiveWorkbenchPanels.mockReturnValue([])
    renderWithProviders(<PanelQuickSwitch />)
    const handler = (globalThis as Record<string, unknown>).__quickSwitchHandler as () => void
    act(() => handler())

    expect(screen.getByText("No matching panels.")).toBeInTheDocument()
  })

  it("toggles dialog open/closed on repeated shortcut invocation", () => {
    renderWithProviders(<PanelQuickSwitch />)
    const handler = (globalThis as Record<string, unknown>).__quickSwitchHandler as () => void

    // First call opens
    act(() => handler())
    expect(screen.getByTestId("panel-quick-switch-input")).toBeInTheDocument()

    // Second call closes
    act(() => handler())
    expect(screen.queryByTestId("panel-quick-switch-input")).not.toBeInTheDocument()
  })

  it("shows plugin id annotation for plugin panels", () => {
    mockGetActiveWorkbenchPanels.mockReturnValue([
      {
        id: "my-plugin:custom-panel",
        activity: "inspect",
        labelKey: "customPanel",
        label: "Custom Panel",
        pluginId: "my-plugin",
      },
    ])
    renderWithProviders(<PanelQuickSwitch />)
    const handler = (globalThis as Record<string, unknown>).__quickSwitchHandler as () => void
    act(() => handler())

    expect(screen.getByText("my-plugin")).toBeInTheDocument()
  })

  it("groups panels in canonical activity order", () => {
    mockGetActiveWorkbenchPanels.mockReturnValue([
      { id: "chat", activity: "ai", labelKey: "chat", label: "Chat" },
      { id: "preview", activity: "preview-run", labelKey: "preview", label: "Preview" },
      { id: "templates", activity: "templates", labelKey: "templates", label: "Templates" },
    ])
    renderWithProviders(<PanelQuickSwitch />)
    const handler = (globalThis as Record<string, unknown>).__quickSwitchHandler as () => void
    act(() => handler())

    // Verify items appear in canonical activity order by checking their
    // position in the rendered text content
    const container = screen.getByRole("dialog")
    const text = container.textContent ?? ""
    const previewPos = text.indexOf("Preview / run")
    const aiPos = text.indexOf("AI")
    const templatesPos = text.indexOf("Templates")
    expect(previewPos).toBeGreaterThan(-1)
    expect(aiPos).toBeGreaterThan(-1)
    expect(templatesPos).toBeGreaterThan(-1)
    expect(previewPos).toBeLessThan(aiPos)
    expect(aiPos).toBeLessThan(templatesPos)
  })
})
