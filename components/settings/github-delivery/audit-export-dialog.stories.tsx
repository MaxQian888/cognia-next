import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AuditExportDialog, type AuditExportColumn } from "./audit-export-dialog"

// Generic audit-log export dialog (zip / md / csv / json), shared by the
// GitHub Delivery and Workflow audit tabs. Pure props: it never re-queries —
// `rows` are pre-filtered and `columns` project them per format. Click the
// trigger to open the format picker.
interface AuditRow {
  id: string
  action: string
  actor: string
  ts: string
}

const rows: AuditRow[] = [
  { id: "1", action: "comment.posted", actor: "octocat", ts: "2026-06-28T10:00:00Z" },
  { id: "2", action: "pr.merged", actor: "hubot", ts: "2026-06-28T11:30:00Z" },
  { id: "3", action: "policy.blocked", actor: "octocat", ts: "2026-06-28T12:05:00Z" },
]

const columns: AuditExportColumn<AuditRow>[] = [
  { header: "ID", accessor: (r) => r.id },
  { header: "Action", accessor: (r) => r.action },
  { header: "Actor", accessor: (r) => r.actor },
  { header: "Timestamp", accessor: (r) => r.ts },
]

const meta = {
  title: "Settings/GithubDelivery/AuditExportDialog",
  component: AuditExportDialog,
  parameters: { layout: "centered" },
  // Empty required-args defaults so the render-based stories type-check (the
  // generic TRow resolves to unknown at the meta level); each story supplies
  // its own concrete typed rows/columns via render.
  args: { rows: [], columns: [], filename: "github-delivery-audit", onExport: fn() },
} satisfies Meta<typeof AuditExportDialog>

export default meta
type Story = StoryObj<typeof meta>

// Three rows ready to export; the dialog opens from the default "Export" button.
export const Default: Story = {
  render: () => (
    <AuditExportDialog<AuditRow>
      title="Export GitHub delivery audit"
      rows={rows}
      columns={columns}
      filename="github-delivery-audit"
      filtersSnapshot={{ repo: "acme/widgets", actor: "octocat" }}
      onExport={fn()}
    />
  ),
}

// Empty result set — still exportable (produces an empty table/array).
export const NoRows: Story = {
  render: () => (
    <AuditExportDialog<AuditRow>
      rows={[]}
      columns={columns}
      filename="github-delivery-audit"
      onExport={fn()}
    />
  ),
}
