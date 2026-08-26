import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"

import { MediaGrantEditor } from "./media-grant-editor"
import type { MediaModelGrant } from "@/lib/connectors/media-model-gate"

const NOW = 1_700_000_000_000

/** Controlled by the story so the switches actually move. */
function Controlled({
  initial,
  providers,
  effectiveProvider,
}: {
  initial?: MediaModelGrant
  providers: string[]
  effectiveProvider?: string
}) {
  const [value, setValue] = useState(initial)
  return (
    <MediaGrantEditor
      value={value}
      onChange={setValue}
      providers={providers}
      effectiveProvider={effectiveProvider}
      now={NOW}
    />
  )
}

const meta = {
  title: "Inbox/MediaGrantEditor",
  component: Controlled,
  args: { providers: ["anthropic", "openai"], effectiveProvider: "anthropic" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Controlled>

export default meta
type Story = StoryObj<typeof meta>

/** The default for every conversation: attachments never leave the device. */
export const NotGranted: Story = {}

export const Granted: Story = {
  args: {
    providers: ["anthropic", "openai"],
    initial: {
      policy: "allow_cloud_binary",
      providers: ["anthropic"],
      grantedAt: NOW,
      expiresAt: NOW + 24 * 3_600_000,
    },
  },
}

/** Nothing sweeps an expired grant, so the row can still hold one. */
export const Expired: Story = {
  args: {
    providers: ["anthropic", "openai"],
    initial: {
      policy: "allow_cloud_binary",
      providers: ["anthropic"],
      grantedAt: NOW - 48 * 3_600_000,
      expiresAt: NOW - 3_600_000,
    },
  },
}

/** A grant with no providers grants nothing — the editor says so. */
export const NoProviderSelected: Story = {
  args: {
    providers: ["anthropic", "openai"],
    initial: { policy: "allow_cloud_binary", providers: [], grantedAt: NOW },
  },
}
