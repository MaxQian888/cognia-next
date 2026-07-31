import type { Meta, StoryObj } from "@storybook/nextjs"

import { TitleBarQuickActions } from "./title-bar-quick-actions"
import { resetStores } from "@/lib/storybook/seed-stores"
import { usePetStore } from "@/stores/pet/pet-store"

// Quick-actions cluster: pet show/hide toggle, OCR, and capture entry points.
const meta = {
  title: "Desktop/TitleBar/QuickActions",
  component: TitleBarQuickActions,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStores(usePetStore)
  },
  decorators: [
    (Story) => (
      <div className="flex h-8 items-center bg-muted/40 text-xs">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TitleBarQuickActions>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const PetHidden: Story = {
  beforeEach: () => {
    resetStores(usePetStore)
    usePetStore.setState({ minimized: true })
  },
}
