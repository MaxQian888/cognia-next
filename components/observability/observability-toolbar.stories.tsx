import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ObservabilityToolbar } from "./observability-toolbar"
import { makeTraceRows, makeWindowSpans } from "@/lib/storybook/fixtures/observability"
import { DASHBOARD_CONFIG_VERSION } from "@/lib/observability/dashboard-config"

// `ObservabilityToolbar` composes the variable filter bar, time-range picker,
// refresh + export controls, settings, and the edit/lock + reset-layout controls.
// It is the `/logs` Traces channel's toolbar; the layout controls only apply to
// the Dashboard sub-view, hence `showLayoutControls`.
const meta = {
  title: "Observability/Toolbar",
  component: ObservabilityToolbar,
  args: {
    preset: "1h",
    customSince: null,
    customUntil: null,
    refreshMs: 10_000,
    filters: {},
    editMode: false,
    windowSpans: makeWindowSpans(),
    lastUpdated: null,
    // What "export recent traces → CSV" would actually write.
    traces: makeTraceRows(),
    onPreset: fn(),
    onCustom: fn(),
    onRefreshMs: fn(),
    onRefresh: fn(),
    onFilters: fn(),
    onToggleEdit: fn(),
    onResetLayout: fn(),
    onOpenSettings: fn(),
    buildConfig: () => ({
      version: DASHBOARD_CONFIG_VERSION,
      layouts: null,
      hiddenPanels: [],
      thresholds: {},
      rangePreset: "1h" as const,
      customSince: null,
      customUntil: null,
      refreshMs: 10_000 as const,
      filters: {},
    }),
    onImportConfig: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[860px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ObservabilityToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Locked: Story = {}

export const EditMode: Story = {
  args: { editMode: true },
}

export const WithActiveFilters: Story = {
  args: {
    filters: { surface: ["chat"], model: ["claude-3-opus-20240229"] },
  },
}

/** Explore sub-view: same controls, minus the grid-only layout editing. */
export const WithoutLayoutControls: Story = {
  args: { showLayoutControls: false },
}

/**
 * Narrow-channel layout: the seven dimension dropdowns fold behind one
 * "Filters" trigger and the export / edit labels give way to their icons, so
 * the row stays one line inside a ~500px pane.
 */
export const Compact: Story = {
  args: { compact: true },
  decorators: [
    (Story) => (
      <div className="w-[560px] border p-2">
        <Story />
      </div>
    ),
  ],
}
