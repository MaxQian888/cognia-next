import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SavedThemesRail, type SavedThemesRailLabels } from "./saved-themes-rail"
import { DEFAULT_FALLBACKS } from "@/lib/appearance"
import type { CustomTheme } from "@/types/plugin/plugin"

// Rail of saved custom themes with per-row activate / duplicate / export /
// delete actions and a "start new" empty state. Pure props.
const LABELS: SavedThemesRailLabels = {
  title: "Saved themes",
  empty: "No saved themes yet.",
  startNew: "Start a new theme",
  activate: "Activate",
  deactivate: "Deactivate",
  duplicate: "Duplicate",
  export: "Export",
  delete: "Delete",
  more: "More actions",
  lightSwatchAria: "Light variant swatch",
  darkSwatchAria: "Dark variant swatch",
  activeBadgeAria: "Active theme",
}

const themes: CustomTheme[] = [
  {
    id: "theme-ocean",
    name: "Ocean",
    baseVariant: "dark",
    tokens: { light: DEFAULT_FALLBACKS.light, dark: DEFAULT_FALLBACKS.dark },
  },
  {
    id: "theme-rose",
    name: "Rosé",
    baseVariant: "light",
    colors: { background: "#fff1f2", primary: "#e11d48" },
    isDark: false,
  },
]

const handlers = {
  onSelect: fn(),
  onActivate: fn(),
  onDeactivate: fn(),
  onDuplicate: fn(),
  onExport: fn(),
  onDelete: fn(),
  onNew: fn(),
}

const meta = {
  title: "Settings/Appearance/SavedThemesRail",
  component: SavedThemesRail,
  parameters: { layout: "padded" },
  args: { themes, activeId: null, editingId: undefined, labels: LABELS, ...handlers },
} satisfies Meta<typeof SavedThemesRail>

export default meta
type Story = StoryObj<typeof meta>

// Two saved themes, none active.
export const WithThemes: Story = {}

// One theme active and currently being edited.
export const ActiveAndEditing: Story = {
  args: { activeId: "theme-ocean", editingId: "theme-ocean" },
}

// No saved themes → empty state + "start new".
export const Empty: Story = {
  args: { themes: [] },
}
