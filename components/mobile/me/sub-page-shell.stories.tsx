import type { Meta, StoryObj } from "@storybook/nextjs"
import { Badge } from "@/components/ui/badge"

import { SubPageShell } from "./sub-page-shell"

// Shared chrome for every /me/<section> sub-page: sticky back header + title +
// Suspense body. Props-only.
const meta = {
  title: "Mobile/Me/SubPageShell",
  component: SubPageShell,
  parameters: { layout: "fullscreen" },
  args: {
    title: "Appearance",
    backAria: "Back to profile",
    children: (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Sub-page body content renders inside the shell&apos;s scroll container.
        </p>
        <div className="h-40 rounded-lg border bg-card" />
        <div className="h-40 rounded-lg border bg-card" />
      </div>
    ),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubPageShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithHeaderAccessory: Story = {
  args: {
    title: "Subscription",
    headerAccessory: <Badge variant="outline">PRO</Badge>,
  },
}

export const Wide: Story = {
  args: { title: "Profile", width: "wide" },
}
