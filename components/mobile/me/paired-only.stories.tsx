import type { Meta, StoryObj } from "@storybook/nextjs"

import { PairedOnly } from "./paired-only"
import { MeSection } from "./me-section"
import { MeRow } from "./me-row"

// Gate for agent-class settings that only work when paired to a desktop. The
// Storybook browser has no pairing JWT, so `useCompanionConfig().paired` is
// false and the "connect a desktop" placeholder is shown instead of children.
const meta = {
  title: "Mobile/Me/PairedOnly",
  component: PairedOnly,
  parameters: { layout: "padded" },
  args: {
    children: (
      <MeSection title="Agent runtime">
        <MeRow label="Permission mode" value="Default" href="#" />
      </MeSection>
    ),
  },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PairedOnly>

export default meta
type Story = StoryObj<typeof meta>

// Unpaired (the Storybook default): renders the placeholder, not the children.
export const UnpairedPlaceholder: Story = {}
