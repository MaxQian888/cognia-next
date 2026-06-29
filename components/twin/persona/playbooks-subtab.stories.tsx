import type { Meta, StoryObj } from "@storybook/nextjs"

import { PlaybooksSubtab } from "./playbooks-subtab"
import { makePlaybook } from "@/lib/storybook/fixtures/twin"

// Pure rendering — playbooks array passed by the parent. Pinned first, then by
// confidence descending.
const meta = {
  title: "Twin/Persona/PlaybooksSubtab",
  component: PlaybooksSubtab,
  parameters: { layout: "padded" },
  args: {
    twinId: "twin-1",
    playbooks: [
      makePlaybook({ title: "P1 Outage Response", confidence: 0.91, pinned: true }),
      makePlaybook({ title: "Refund Request Handling", confidence: 0.74 }),
      makePlaybook({ title: "Feature Request Triage", confidence: 0.55 }),
    ],
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PlaybooksSubtab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Empty: Story = {
  args: { playbooks: [] },
}
