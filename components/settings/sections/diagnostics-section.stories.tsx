import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiagnosticsSection } from "./diagnostics-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { clearDb } from "@/lib/storybook/seed-db"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Composite tabbed section: Crash logs / Native reports / System. The System
// tab aggregates the developer-flags, sandbox-audit, plugin-messaging, sidecar
// and inbox-telemetry cards (each storied on its own). Seed the settings store
// so the developer-flags card renders and start from an empty IndexedDB.
const meta = {
  title: "Settings/Sections/DiagnosticsSection",
  component: DiagnosticsSection,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings() })
    await clearDb()
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiagnosticsSection>

export default meta
type Story = StoryObj<typeof meta>

// Default tab (Crash logs).
export const Default: Story = {}
