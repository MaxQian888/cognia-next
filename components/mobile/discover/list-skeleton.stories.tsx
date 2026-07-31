import type { Meta, StoryObj } from "@storybook/nextjs"

import { ListSkeleton } from "./list-skeleton"

// Loading placeholder for the Discover card lists — mirrors the row shape of
// CharacterCard / TeamCard / SkillCard so the swap to real content doesn't
// shift layout.
const meta = {
  title: "Mobile/Discover/ListSkeleton",
  component: ListSkeleton,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ListSkeleton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const FewRows: Story = {
  args: { rows: 2 },
}

export const ManyRows: Story = {
  args: { rows: 8 },
}
