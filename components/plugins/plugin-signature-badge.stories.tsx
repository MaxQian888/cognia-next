import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginSignatureBadge, type SignatureState } from "./plugin-signature-badge"

const STATES: SignatureState[] = ["verified", "unverified", "failed", "unknown"]

const meta = {
  title: "Plugins/PluginSignatureBadge",
  component: PluginSignatureBadge,
  args: { state: "verified", signer: "Acme Publishing" },
} satisfies Meta<typeof PluginSignatureBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Verified: Story = {}

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATES.map((s) => (
        <PluginSignatureBadge key={s} state={s} signer="Acme Publishing" />
      ))}
    </div>
  ),
}

export const Compact: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATES.map((s) => (
        <PluginSignatureBadge key={s} state={s} compact />
      ))}
    </div>
  ),
}
