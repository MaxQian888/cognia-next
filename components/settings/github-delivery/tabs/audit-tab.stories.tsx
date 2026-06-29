import type { Meta, StoryObj } from "@storybook/nextjs"

import { AuditTab } from "./audit-tab"

// GitHub Delivery → Audit tab: the delivery audit log (Dexie-backed) with
// surface/decision filters and the shared AuditExportDialog. Empty in the
// browser (fresh IndexedDB). No props.
const meta = {
  title: "Settings/GithubDelivery/Tabs/AuditTab",
  component: AuditTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof AuditTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
