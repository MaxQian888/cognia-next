import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetInteractionPanel } from "./pet-interaction-panel"
import { resetStore } from "@/lib/storybook/seed-stores"
import { usePetStore } from "@/stores/pet/pet-store"
import { makePetProfile, makePetView, makePetNeeds } from "@/lib/storybook/fixtures/pet-core"

// The expanded-widget interaction panel: stat card + need bars + level/XP + the
// feed/play/pet/talk actions (talk reveals a composer). Reads `lastGrewStats`
// from the pet store, so reset it between stories.
const meta = {
  title: "Pet/InteractionPanel",
  component: PetInteractionPanel,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(usePetStore)
  },
  args: {
    profile: makePetProfile(),
    view: makePetView(),
    onFeed: fn(),
    onPlay: fn(),
    onPet: fn(),
    onTalk: fn(),
  },
  decorators: [
    (Story) => (
      <div className="rounded-xl border bg-popover p-3 shadow-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetInteractionPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Healthy: Story = {}

export const LowNeeds: Story = {
  args: {
    view: makePetView({ needs: makePetNeeds({ energy: 14, mood: 28, bond: 40 }) }),
  },
}

export const FreshlyHatched: Story = {
  args: {
    profile: makePetProfile({ xp: 5, level: 1, stage: "baby" }),
  },
}
