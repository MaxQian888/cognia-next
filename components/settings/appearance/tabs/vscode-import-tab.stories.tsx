import type { Meta, StoryObj } from "@storybook/nextjs"

import { VscodeImportTab } from "./vscode-import-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Import tab: the VSCode import form plus the import-history list.
// Reads the settings store (importedVscodeThemes, active id).
const meta = {
  title: "Settings/Appearance/Tabs/VscodeImportTab",
  component: VscodeImportTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof VscodeImportTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty history → just the dropzone + preset grid.
export const Default: Story = {}
