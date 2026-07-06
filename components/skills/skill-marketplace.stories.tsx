import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillMarketplace } from "./skill-marketplace"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills/skills-store"

// Propless Browse tab. `useSkillMarketplace` fetches listings over the network;
// in Storybook the request resolves to an empty/error state and the master-
// detail layout renders its loading + empty branches.
const meta = {
  title: "Skills/SkillMarketplace",
  component: SkillMarketplace,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-full flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillMarketplace>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
