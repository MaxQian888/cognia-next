import type { Meta, StoryObj } from "@storybook/nextjs"

import { StyleSamplesSubtab } from "./style-samples-subtab"
import { makeStyleSample } from "@/lib/storybook/fixtures/twin"

// Pure rendering — styleSamples array passed by the parent. Pinned first, then
// most-recent first.
const meta = {
  title: "Twin/Persona/StyleSamplesSubtab",
  component: StyleSamplesSubtab,
  parameters: { layout: "padded" },
  args: {
    twinId: "twin-1",
    styleSamples: [
      makeStyleSample({ contextLabel: "Customer apology", tone: ["empathetic"], pinned: true }),
      makeStyleSample({ contextLabel: "Status update", tone: ["concise", "factual"] }),
      makeStyleSample({ contextLabel: "PR description", tone: ["technical"] }),
    ],
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StyleSamplesSubtab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Empty: Story = {
  args: { styleSamples: [] },
}
