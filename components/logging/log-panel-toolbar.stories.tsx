import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LogPanelToolbar } from "./log-panel-toolbar"

// Pure (memoized) 3-layer toolbar. Every prop is supplied; handlers are `fn()`
// spies so the Actions panel records clicks. Stories toggle the props that
// change the rendered surface (advanced filters, regex, auto-refresh).
const meta = {
  title: "Logging/LogPanelToolbar",
  component: LogPanelToolbar,
  parameters: { layout: "fullscreen" },
  args: {
    viewMode: "list",
    setViewMode: fn(),
    includeAgentTrace: true,
    searchQuery: "",
    setSearchQuery: fn(),
    useRegex: false,
    setUseRegex: fn(),
    levelFilter: "all",
    setLevelFilter: fn(),
    moduleFilter: "all",
    setModuleFilter: fn(),
    augmentedModules: ["network:lark", "agent:team", "workflow", "ui:chat"],
    sourceFilter: "all",
    setSourceFilter: fn(),
    allowedSources: ["frontend", "tauri", "mcp", "plugin", "internal"],
    sessionFilter: "",
    setSessionFilter: fn(),
    timeRange: "all",
    setTimeRange: fn(),
    stats: {
      total: 1240,
      byLevel: { trace: 80, debug: 420, info: 600, warn: 110, error: 30, fatal: 0 },
    },
    presets: [],
    activePresetId: "",
    handlePresetChange: fn(),
    saveCurrentPreset: fn(),
    removeActivePreset: fn(),
    EMPTY_PRESET_VALUE: "",
    highSeverityOnly: false,
    setHighSeverityOnly: fn(),
    traceFocusId: null,
    setTraceFocusId: fn(),
    autoRefresh: false,
    setAutoRefresh: fn(),
    refresh: fn(),
    onExport: fn(),
    clearLogs: fn(),
    showDetailPanel: false,
    setShowDetailPanel: fn(),
    autoScroll: true,
    setAutoScroll: fn(),
    scrollToTop: fn(),
    scrollToBottom: fn(),
    clearSessionFocus: fn(),
    hasSessionFocus: false,
    bookmarkFilterActive: false,
    setBookmarkFilterActive: fn(),
    bookmarkedCount: 3,
    showAdvancedFilters: false,
    setShowAdvancedFilters: fn(),
    showShortcutsDialog: false,
    setShowShortcutsDialog: fn(),
    searchHistory: ["timeout", "error", "trace-01"],
    addSearchHistory: fn(),
    removeSearchHistoryItem: fn(),
    clearSearchHistory: fn(),
    diagnosticTransportFilter: null,
    setDiagnosticTransportFilter: fn(),
    customTimeRange: null,
    setCustomTimeRange: fn(),
    density: "comfortable",
    setDensity: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogPanelToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// Layer 3 (module / source / session / time / presets) expanded.
export const AdvancedFiltersOpen: Story = {
  args: { showAdvancedFilters: true },
}

// Regex search on + auto-refresh spinning + an error-level tab active.
export const RegexAndAutoRefresh: Story = {
  args: {
    useRegex: true,
    searchQuery: "tool.*timeout",
    autoRefresh: true,
    levelFilter: "error",
    highSeverityOnly: true,
  },
}

// Active facet chips appear when filters are set.
export const WithActiveFacets: Story = {
  args: {
    moduleFilter: "network:lark",
    sourceFilter: "tauri",
    sessionFilter: "sess-42",
    timeRange: "1h",
    traceFocusId: "trace-01aa11bb22",
  },
}
