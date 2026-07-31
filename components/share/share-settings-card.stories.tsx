import type { Meta, StoryObj } from "@storybook/nextjs"

import { ShareSettingsCard } from "./share-settings-card"

// Settings card for the self-hosted share worker (URL + upload secret), with the
// owner's My Shares panel below. Loads settings from Dexie (empty in Storybook,
// so the fields start blank).
const meta = {
  title: "Share/ShareSettingsCard",
  component: ShareSettingsCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ShareSettingsCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
