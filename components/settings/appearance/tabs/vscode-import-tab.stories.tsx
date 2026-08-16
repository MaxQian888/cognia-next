import type { Meta, StoryObj } from "@storybook/nextjs"

import { VscodeImportTab } from "./vscode-import-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Import tab: the VSCode import form plus the import-history list.
// Reads the settings store (importedVscodeThemes, active id).
// Multi-column layout here sizes off `@container/appearance-pane`, which
// `appearance-section.tsx` owns in the real app — the decorator stands in for
// it so this story previews the same layout the settings pane shows.
const meta = {
  title: "Settings/Appearance/Tabs/VscodeImportTab",
  component: VscodeImportTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="@container/appearance-pane">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof VscodeImportTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty history → just the dropzone + preset grid.
export const Default: Story = {}
