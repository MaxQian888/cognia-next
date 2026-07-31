/**
 * @jest-environment jsdom
 */
import React, { createContext, useContext } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

import type { LogPanelHeaderApi } from "@/components/logging/log-panel"

// Stub LogPanel so the test focuses on the page-level header. The stub
// provides a Context with deterministic counts/presets so `useLogPanelHeader`
// inside the page's header component resolves correctly.
const StubHeaderContext = createContext<LogPanelHeaderApi | null>(null)
const STUB_API: LogPanelHeaderApi = {
  totalCount: 200,
  filteredCount: 47,
  activePresetId: "__none__",
  presets: [
    {
      id: "preset-1",
      name: "Errors only",
      version: 1,
      createdAt: "2026-01-01T00:00:00Z",
      filters: {
        levelFilter: "error",
        moduleFilter: "all",
        timeRange: "1h",
        searchQuery: "",
        useRegex: false,
        highSeverityOnly: true,
      },
    },
  ],
  handlePresetChange: jest.fn(),
  onOpenShortcuts: jest.fn(),
  EMPTY_PRESET_VALUE: "__none__",
}

let capturedHideToolbarPresets = false

jest.mock("@/components/logging/log-panel", () => ({
  LogPanel: (props: { headerSlot?: React.ReactNode; hideToolbarPresets?: boolean }) => {
    capturedHideToolbarPresets = props.hideToolbarPresets ?? false
    return (
      <StubHeaderContext.Provider value={STUB_API}>
        <div data-testid="stub-log-panel">{props.headerSlot}</div>
      </StubHeaderContext.Provider>
    )
  },
  useLogPanelHeader: () => {
    const ctx = useContext(StubHeaderContext)
    if (!ctx) throw new Error("missing stub header context")
    return ctx
  },
}))

import LogsPage from "./page"

function renderPage() {
  return render(
    <TooltipProvider delayDuration={0}>
      <LogsPage />
    </TooltipProvider>
  )
}

beforeEach(() => {
  capturedHideToolbarPresets = false
})

describe("/logs page", () => {
  it("passes hideToolbarPresets to LogPanel so the host header owns presets", () => {
    renderPage()
    expect(capturedHideToolbarPresets).toBe(true)
    expect(screen.getByTestId("logs-page-header")).toBeInTheDocument()
  })

  it("renders the breadcrumb (Home → Logs)", () => {
    renderPage()
    expect(screen.getByTestId("logs-page-header")).toBeInTheDocument()
    expect(screen.getByText("Home")).toBeInTheDocument()
    expect(screen.getAllByText("Logs")).toHaveLength(2)
  })

  it("renders the live-pill with filteredCount / totalCount", () => {
    renderPage()
    const pill = screen.getByTestId("logs-page-header-live-pill")
    // The global next-intl mock interpolates `{filtered}` and `{total}`
    // even when the key resolves to the raw fallback.
    expect(pill.textContent ?? "").toContain("47")
    expect(pill.textContent ?? "").toContain("200")
  })

  it("renders the preset Select with available presets", () => {
    renderPage()
    const trigger = screen.getByTestId("log-page-header-preset-trigger")
    expect(trigger).toBeInTheDocument()
  })

  it("invokes onOpenShortcuts when the help button is clicked", () => {
    renderPage()
    const helpButton = screen.getByTestId("logs-page-header-help")
    fireEvent.click(helpButton)
    expect(STUB_API.onOpenShortcuts).toHaveBeenCalled()
  })
})
