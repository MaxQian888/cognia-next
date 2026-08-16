import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ErrorReportActions, type ErrorReportCopy } from "./error-report-actions"

const copy: ErrorReportCopy = {
  copyReport: "Copy full report",
  copyReportSuccess: "Report copied",
  copyReportFailed: "Failed to copy",
  reportIssue: "Report issue",
  reportIssueFailed: "Failed to open the issue tracker",
}

const error = Object.assign(new Error("Render failed"), { digest: "abc123" })

// Error-page report actions: "Copy full report" and "Report issue" — both
// backed by the unified support-report channels, with the shell IO stubbed.
const meta = {
  title: "Error/ErrorReportActions",
  component: ErrorReportActions,
  args: {
    error,
    copy,
    context: { category: "render", locale: "en", pathname: "/" },
    toastsEnabled: true,
    channelDeps: { writeClipboard: fn(), openExternal: fn() },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ErrorReportActions>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const ConfiguredTracker: Story = {
  args: { issueReportUrl: "https://github.com/example/repo" },
}
