import type { Meta, StoryObj } from "@storybook/nextjs"

import { ErrorDiagnosticsCard, type ErrorDiagnosticsCopy } from "./error-diagnostics-card"

const copy: ErrorDiagnosticsCopy = {
  title: "System diagnostics",
  appVersion: "App version",
  platform: "Platform",
  osVersion: "OS version",
  runtime: "Runtime",
  online: "Online",
  offline: "Offline",
  locale: "Locale",
  route: "Route",
  category: "Category",
  runtimeDesktop: "Desktop app",
  runtimeBrowser: "Browser",
}

// Collapsible system-diagnostics card for the error page. Takes resolved copy +
// locale + route as props (provider-agnostic); diagnostics load best-effort.
const meta = {
  title: "Error/ErrorDiagnosticsCard",
  component: ErrorDiagnosticsCard,
  args: { copy, categoryLabel: "Application error", locale: "en", pathname: "/artifacts" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ErrorDiagnosticsCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NetworkCategory: Story = {
  args: { categoryLabel: "Network error", pathname: "/inbox" },
}
