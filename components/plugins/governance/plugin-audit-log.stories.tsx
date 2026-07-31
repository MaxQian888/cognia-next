import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginAuditLog } from "./plugin-audit-log"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import type { PluginPermission } from "@/types/plugin"

// Cross-plugin audit-log surface. It reads the permission guard's in-memory
// ring buffer via `usePluginPermissions().auditLog` (no prop surface), so each
// story seeds the *real* guard singleton through its public API before mount —
// `grant` / `revoke` / `request` each push an audit entry of the matching
// action type. `getAuditLog()` is snapshotted on first render, so seeding
// synchronously inside `render()` (after clearing for isolation) is enough; no
// mocking required. Stories cover the empty state and a populated mix of
// grant / revoke / request rows across several plugins.

// Seed the shared guard with a deterministic set of audit rows. Clearing first
// keeps stories isolated from one another (the guard is a process singleton).
function seedAuditLog(
  rows: Array<{
    pluginId: string
    permission: PluginPermission
    action: "grant" | "revoke" | "request"
  }>
) {
  const guard = getPermissionGuard()
  guard.clearAuditLog()
  for (const row of rows) {
    if (row.action === "grant") {
      guard.grant(row.pluginId, row.permission)
    } else if (row.action === "revoke") {
      guard.revoke(row.pluginId, row.permission)
    } else {
      // `request` audits a "request" entry synchronously before its async
      // handler resolves, which is all we need for the buffer snapshot.
      void guard.request(row.pluginId, row.permission, "story-seed")
    }
  }
}

const meta = {
  title: "Plugins/Governance/PluginAuditLog",
  component: PluginAuditLog,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[720px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginAuditLog>

export default meta
type Story = StoryObj<typeof meta>

// No events yet — the empty-state message and disabled export button.
export const Empty: Story = {
  render: () => {
    getPermissionGuard().clearAuditLog()
    return <PluginAuditLog />
  },
}

// A realistic spread of grant / revoke / request decisions across plugins,
// exercising both filter selects and the export button.
export const Populated: Story = {
  render: () => {
    seedAuditLog([
      { pluginId: "com.acme.clipboard", permission: "clipboard:read", action: "grant" },
      { pluginId: "com.acme.clipboard", permission: "clipboard:write", action: "grant" },
      { pluginId: "com.acme.web-tools", permission: "network:fetch", action: "request" },
      { pluginId: "com.acme.web-tools", permission: "network:fetch", action: "grant" },
      { pluginId: "com.acme.shell-runner", permission: "shell:execute", action: "request" },
      { pluginId: "com.acme.shell-runner", permission: "shell:execute", action: "revoke" },
      { pluginId: "com.acme.screenshot", permission: "automation:screenshot", action: "grant" },
      { pluginId: "com.acme.screenshot", permission: "automation:screenshot", action: "revoke" },
    ])
    return <PluginAuditLog />
  },
}

// A single plugin with a tight grant→revoke→re-grant lifecycle, useful for
// eyeballing the per-action Badge variants in isolation.
export const SinglePlugin: Story = {
  render: () => {
    seedAuditLog([
      { pluginId: "com.acme.ocr", permission: "filesystem:read", action: "request" },
      { pluginId: "com.acme.ocr", permission: "filesystem:read", action: "grant" },
      { pluginId: "com.acme.ocr", permission: "filesystem:read", action: "revoke" },
    ])
    return <PluginAuditLog />
  },
}
