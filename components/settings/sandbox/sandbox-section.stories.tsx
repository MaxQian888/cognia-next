import type { Meta, StoryObj } from "@storybook/nextjs"

import { SandboxSection } from "./sandbox-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Composite section: a health card driven by `useSandboxHealth` (the Rust probe
// rejects in the Storybook browser, so the badge reads "Setup required") above
// the enable / canvas / tier / resource-policy / automation-policy cards, all of
// which read the settings store. Seed a realistic `AppSettings` so the child
// cards render meaningful state. Reset the store between stories.
const meta = {
  title: "Settings/Sandbox/SandboxSection",
  component: SandboxSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({
        sandboxDefaultEnabled: true,
        canvasCodeSandboxEnabled: true,
        sandboxTier: "os",
        sandboxPolicy: { maxCpuSeconds: 30, maxMemoryMb: 512, network: "off" },
      }),
    })
  },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SandboxSection>

export default meta
type Story = StoryObj<typeof meta>

// Full Sandbox settings surface — health card (web "setup required") + cards.
export const Default: Story = {}
