import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasCodeSandboxCard } from "./canvas-code-sandbox-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Store-reading: the switch reflects `settings.canvasCodeSandboxEnabled`, which
// defaults to TRUE (Canvas-executed code is confined out of the box). Reset the
// settings store between stories.
function seed(canvasCodeSandboxEnabled: boolean) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings({ canvasCodeSandboxEnabled }) })
  }
}

const meta = {
  title: "Settings/Sandbox/CanvasCodeSandboxCard",
  component: CanvasCodeSandboxCard,
  parameters: { layout: "padded" },
  beforeEach: seed(true),
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasCodeSandboxCard>

export default meta
type Story = StoryObj<typeof meta>

// Confined by default (the shipped behaviour).
export const Default: Story = {}

// Explicit opt-out — Canvas code runs as a bare host subprocess.
export const Disabled: Story = {
  beforeEach: seed(false),
}
