import type { Meta, StoryObj } from "@storybook/nextjs"

import { StatusBarConnectivity } from "./status-bar-connectivity"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useUIStore } from "@/stores/ui/ui-store"

// Compact connectivity segment. In Storybook the network hook resolves via
// `navigator.onLine`; the companion tier is absent (web), so it reads "online".
const meta = {
  title: "Desktop/StatusBar/Connectivity",
  component: StatusBarConnectivity,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStores(useUIStore)
  },
  decorators: [
    (Story) => (
      <div className="flex h-6 items-center border-t bg-muted/40 text-[11px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusBarConnectivity>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
