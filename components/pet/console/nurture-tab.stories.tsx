import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { NurtureTab } from "./nurture-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { usePetStore } from "@/stores/pet/pet-store"
import { makePetProfile, makePetView, makePetNeeds } from "@/lib/storybook/fixtures/pet-core"

// The `/pet` console nurture tab: a wide, responsive home for the hatched pet —
// stat card, level/XP, need bars, the six cooldown-gated care actions, and a
// large hero preview. Reads `lastGrewStats` / cooldowns from the pet store.
const meta = {
  title: "Pet/Console/NurtureTab",
  component: NurtureTab,
  parameters: { layout: "fullscreen" },
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
    onSleep: fn(),
    onClean: fn(),
    onTreat: fn(),
  },
  decorators: [
    // The tab lays out against the console's scrolling pane, which is the
    // `pet-pane` container its two-column breakpoint measures.
    (Story) => (
      <div className="@container/pet-pane p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NurtureTab>

export default meta
type Story = StoryObj<typeof meta>

export const Healthy: Story = {}

export const Neglected: Story = {
  args: {
    view: makePetView({ needs: makePetNeeds({ energy: 8, mood: 18, bond: 30 }) }),
  },
}
