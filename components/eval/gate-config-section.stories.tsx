import type { Meta, StoryObj } from "@storybook/nextjs"

import { GateConfigSection } from "./gate-config-section"

// Pure form over the four optional gate thresholds. Saving persists to the
// dataset via Dexie (`updateDataset`) — a no-op against the empty Storybook DB.
const meta = {
  title: "Eval/GateConfigSection",
  component: GateConfigSection,
  parameters: { layout: "padded" },
  args: { datasetId: "ds-1" },
  decorators: [
    (Story) => (
      <div className="max-w-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GateConfigSection>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const WithThresholds: Story = {
  args: {
    gate: { minPassAt1: 0.9, minPassHatK: 0.95, minScorerPassRate: 0.8, maxTotalCostUsd: 1.5 },
  },
}
