import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RefreshSelect } from "./refresh-select"

// `RefreshSelect` is the auto-refresh cadence dropdown (off / 5s / 10s / 30s /
// 1m). Pure props-only — `value` + `onChange`.
const meta = {
  title: "Observability/RefreshSelect",
  component: RefreshSelect,
  args: {
    value: 10_000,
    onChange: fn(),
  },
} satisfies Meta<typeof RefreshSelect>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Off: Story = {
  args: { value: 0 },
}

export const OneMinute: Story = {
  args: { value: 60_000 },
}
