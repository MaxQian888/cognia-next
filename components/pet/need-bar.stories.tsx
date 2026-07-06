import type { Meta, StoryObj } from "@storybook/nextjs"

import { NeedBar } from "./need-bar"

// `NeedBar` is purely presentational: a labelled meter whose fill colour crosses
// from primary → amber → destructive as the value drops past 50 then 25.
const meta = {
  title: "Pet/NeedBar",
  component: NeedBar,
  parameters: { layout: "padded" },
  args: { kind: "energy", value: 82, label: "Energy" },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NeedBar>

export default meta
type Story = StoryObj<typeof meta>

export const Full: Story = {}

export const Mood: Story = { args: { kind: "mood", value: 64, label: "Mood" } }

export const Low: Story = { args: { kind: "bond", value: 38, label: "Bond" } }

export const Critical: Story = { args: { kind: "energy", value: 12, label: "Energy" } }

export const Empty: Story = { args: { kind: "mood", value: 0, label: "Mood" } }
