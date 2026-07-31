import type { Meta, StoryObj } from "@storybook/nextjs"

import {
  OcrCapabilityCostCell,
  OcrCapabilityCountCell,
  OcrCapabilityValueCell,
} from "./ocr-capability-cell"

// The capability cell module exports three sibling presentational cells used
// across the Capabilities tab and the Compare view. `OcrCapabilityValueCell`
// is the meta `component`; the cost/count variants are rendered via `render`
// since their prop shapes differ.
const meta = {
  title: "Settings/Ocr/OcrCapabilityCell",
  component: OcrCapabilityValueCell,
  parameters: { layout: "centered" },
  args: { value: "yes" },
} satisfies Meta<typeof OcrCapabilityValueCell>

export default meta
type Story = StoryObj<typeof meta>

export const ValueYes: Story = { args: { value: "yes" } }
export const ValuePartial: Story = { args: { value: "partial" } }
export const ValueNo: Story = { args: { value: "no" } }

export const CostFree: Story = {
  render: () => <OcrCapabilityCostCell tier="free" />,
}
export const CostLow: Story = {
  render: () => <OcrCapabilityCostCell tier="$" />,
}
export const CostHigh: Story = {
  render: () => <OcrCapabilityCostCell tier="$$$" />,
}

export const CountFinite: Story = {
  render: () => <OcrCapabilityCountCell value={42} />,
}
export const CountUnlimited: Story = {
  render: () => <OcrCapabilityCountCell value={null} />,
}

/** All three cell families side by side, mirroring a capability-matrix row. */
export const MatrixRow: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <OcrCapabilityValueCell value="yes" />
      <OcrCapabilityValueCell value="partial" />
      <OcrCapabilityValueCell value="no" />
      <OcrCapabilityCostCell tier="$$" />
      <OcrCapabilityCountCell value={5} />
      <OcrCapabilityCountCell value={null} />
    </div>
  ),
}
