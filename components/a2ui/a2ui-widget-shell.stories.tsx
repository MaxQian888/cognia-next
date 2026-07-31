import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIWidgetShell } from "./a2ui-widget-shell"

const meta = {
  title: "A2UI/WidgetShell",
  component: A2UIWidgetShell,
  parameters: { layout: "centered" },
  args: {
    title: "Live chart",
    description: "Rendered by a native A2UI widget host.",
    children: (
      <div className="rounded-md bg-muted/40 p-4 text-sm text-muted-foreground">
        Widget body content
      </div>
    ),
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UIWidgetShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Loading: Story = {
  args: { status: "loading", statusLabel: "Booting runtime…" },
}

export const Fallback: Story = {
  args: { status: "fallback", fallbackText: "This widget could not render natively." },
}

export const ErrorState: Story = {
  args: { status: "error", fallbackText: "The widget host crashed." },
}

export const SandboxedHost: Story = {
  args: { hostStrategy: "sandboxed-html", title: "Sandboxed HTML widget" },
}

export const NoChrome: Story = { args: { showChrome: false } }
