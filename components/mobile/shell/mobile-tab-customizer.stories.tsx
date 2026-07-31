import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileTabCustomizerBody } from "./mobile-tab-customizer"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// Bottom-tab customizer body: reorder tabs (dnd-kit), toggle visibility (guarded
// so ≥2 remain), and pick the launch landing tab. Reads/writes the layout via
// `useSettingsStore`. The full `MobileTabCustomizer` wraps this in a Sheet from a
// MeRow; the body is storied directly so it renders inline.
const meta = {
  title: "Mobile/Shell/MobileTabCustomizer",
  component: MobileTabCustomizerBody,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[600px] w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileTabCustomizerBody>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
