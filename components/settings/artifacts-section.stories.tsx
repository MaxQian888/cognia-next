import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactsSection } from "./artifacts-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// `ArtifactsSection` reads `settings.artifacts` (auto-create, min-lines slider,
// enabled-types grid, default panel mode, persistence/review toggles), falling
// back to its own `DEFAULTS` per field.
function seedSettings(patch: Partial<AppSettings>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: patch as unknown as AppSettings })
  }
}

const meta = {
  title: "Settings/ArtifactsSection",
  component: ArtifactsSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactsSection>

export default meta
type Story = StoryObj<typeof meta>

// All controls at their library defaults.
export const Default: Story = {}

// Auto-create off, preview as the default panel mode, higher min-lines.
export const PreviewFirst: Story = {
  beforeEach: seedSettings({
    artifacts: {
      autoCreate: false,
      minLines: 25,
      defaultPanelMode: "preview",
      showNotification: false,
      persistAcrossSessions: true,
      reviewBeforeApply: false,
    },
  } as unknown as Partial<AppSettings>),
}
