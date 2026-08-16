import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PresetGrid, type PresetItem } from "./preset-grid"
import { DEFAULT_FALLBACKS } from "@/lib/appearance"

// Presentational grid of VSCode theme presets from three sources (built-in /
// imported / plugin) with a synthesised 3-swatch icon, a source badge, and a
// per-card overflow menu. Pure props.
const items: PresetItem[] = [
  {
    key: "builtin-light",
    name: "Cognia Light",
    colors: DEFAULT_FALLBACKS.light,
    isDark: false,
    source: "builtin",
  },
  {
    key: "builtin-dark",
    name: "Cognia Dark",
    colors: DEFAULT_FALLBACKS.dark,
    isDark: true,
    source: "builtin",
  },
  {
    key: "imported-monokai",
    name: "Monokai (imported)",
    colors: DEFAULT_FALLBACKS.dark,
    isDark: true,
    source: "imported",
    customThemeId: "ct-monokai",
  },
  {
    key: "plugin-solarized",
    name: "Solarized",
    colors: DEFAULT_FALLBACKS.light,
    isDark: false,
    source: "plugin",
    pluginId: "theme-solarized",
    pluginName: "Solarized Pack",
  },
]

// Multi-column layout here sizes off `@container/appearance-pane`, which
// `appearance-section.tsx` owns in the real app — the decorator stands in for
// it so this story previews the same layout the settings pane shows.
const meta = {
  title: "Settings/Appearance/Tabs/PresetGrid",
  component: PresetGrid,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="@container/appearance-pane">
        <Story />
      </div>
    ),
  ],
  args: {
    items,
    activeKey: "builtin-dark",
    onSelect: fn(),
    onEditCopy: fn(),
    onRemoveImported: fn(),
    onDisablePlugin: fn(),
  },
} satisfies Meta<typeof PresetGrid>

export default meta
type Story = StoryObj<typeof meta>

// Four presets across all sources, one active.
export const Mixed: Story = {}

// No presets → empty-state copy.
export const Empty: Story = {
  args: { items: [], activeKey: null },
}
