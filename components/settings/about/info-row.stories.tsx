import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { InfoRow } from "./info-row"

const meta = {
  title: "Settings/About/InfoRow",
  component: InfoRow,
  args: {
    label: "Version",
    value: "1.4.0",
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof InfoRow>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Mono: Story = {
  args: { label: "Commit", value: "a1b2c3d4e5f6", mono: true },
}

export const LongValue: Story = {
  args: {
    label: "Install path",
    value: "/Users/jane/Library/Application Support/cognia/native/runtime/engine.bin",
    mono: true,
  },
}

export const ReactNodeValue: Story = {
  args: {
    label: "Status",
    value: <span className="text-green-600">Up to date</span>,
  },
}

/** The About cards stack many rows inside one card body. */
export const Stacked: Story = {
  render: () => (
    <div className="max-w-md rounded-xl border bg-card p-4 text-card-foreground">
      <InfoRow label="Version" value="1.4.0" mono />
      <InfoRow label="Build" value="2048" mono />
      <InfoRow label="Commit" value="a1b2c3d4e5f6" mono />
      <InfoRow label="Built at" value="2026-06-25 09:12" />
      <InfoRow label="Channel" value="stable" />
    </div>
  ),
}
