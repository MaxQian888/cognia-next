import type { Meta, StoryObj } from "@storybook/nextjs"

import { DexTab } from "./dex-tab"
import { makePetBones } from "@/lib/storybook/fixtures/pet-core"

// 图鉴 / Dex tab: a read-only gallery of every species themed with the user's
// palette, highlighting the one they own. Props-only.
const meta = {
  title: "Pet/Console/DexTab",
  component: DexTab,
  parameters: { layout: "padded" },
  args: { bones: makePetBones() },
} satisfies Meta<typeof DexTab>

export default meta
type Story = StoryObj<typeof meta>

export const OwnsCat: Story = {}

export const OwnsDuck: Story = {
  args: {
    bones: makePetBones({
      species: "duck",
      hat: "none",
      palette: { primary: "#ffd24a", secondary: "#fff0c2", accent: "#ff9f1c" },
    }),
  },
}
