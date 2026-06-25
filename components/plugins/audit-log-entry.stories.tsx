import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { AuditLogEntry } from "./audit-log-entry"
import type { PermissionAuditEntry } from "@/lib/plugin/security/permission-guard"

const NOW = 1_717_400_000_000

const entry = (over: Partial<PermissionAuditEntry>): PermissionAuditEntry => ({
  pluginId: "github-delivery",
  permission: "net.fetch" as PermissionAuditEntry["permission"],
  action: "grant",
  allowed: true,
  timestamp: NOW,
  ...over,
})

const meta = {
  title: "Plugins/AuditLogEntry",
  component: AuditLogEntry,
  args: { entry: entry({}) },
  // Renders a <li>; wrap in a <ul> for valid markup + visible framing.
  decorators: [(Story) => <ul className="w-96 divide-y rounded-md border">{Story()}</ul>],
} satisfies Meta<typeof AuditLogEntry>

export default meta
type Story = StoryObj<typeof meta>

export const Grant: Story = { args: { entry: entry({ action: "grant" }) } }
export const Deny: Story = { args: { entry: entry({ action: "deny", allowed: false }) } }
export const Revoke: Story = { args: { entry: entry({ action: "revoke", allowed: false }) } }
export const WithPluginColumn: Story = {
  args: { entry: entry({ action: "request" }), showPlugin: true },
}

export const Mixed: Story = {
  render: () => (
    <>
      {(["grant", "request", "deny", "revoke", "check"] as const).map((action, i) => (
        <AuditLogEntry
          key={action}
          entry={entry({
            action,
            permission: `fs.read.${i}` as PermissionAuditEntry["permission"],
            timestamp: NOW + i * 1000,
          })}
          showPlugin
        />
      ))}
    </>
  ),
}
