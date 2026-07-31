import type { Meta, StoryObj } from "@storybook/nextjs"

import { CloudSyncCard } from "./cloud-sync-card"

// `CloudSyncCard` is propless. On mount it reads the persisted WebDAV settings
// from Dexie and probes whether a WebDAV connection is configured. In the
// Storybook browser the DB is empty and no connection exists, so the card
// renders its collapsed compact header (sync trigger + chevron); expanding it
// reveals the connection hint because no server is configured. The Expanded
// story opens the panel via a play step to show that branch.
const meta = {
  title: "Settings/Subscription/CloudSyncCard",
  component: CloudSyncCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CloudSyncCard>

export default meta
type Story = StoryObj<typeof meta>

export const Collapsed: Story = {}
