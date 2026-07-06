import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ErrorReportActions, type ErrorReportCopy } from "./error-report-actions"

const copy: ErrorReportCopy = {
  copyReport: "Copy full report",
  copyReportSuccess: "Report copied",
  copyReportFailed: "Failed to copy",
  reportIssue: "Report issue",
}

const error = Object.assign(new Error("Render failed"), { digest: "abc123" })

// Error-page report actions: "Copy full report" (always) and "Report issue"
// (only when an issue-tracker URL is configured).
const meta = {
  title: "Error/ErrorReportActions",
  component: ErrorReportActions,
  args: {
    error,
    copy,
    context: { category: "render", locale: "en", pathname: "/" },
    toastsEnabled: true,
    writeClipboard: fn(),
    openUrl: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ErrorReportActions>

export default meta
type Story = StoryObj<typeof meta>

export const CopyOnly: Story = {}

export const WithReportIssue: Story = {
  args: { issueReportUrl: "https://github.com/example/repo" },
}
