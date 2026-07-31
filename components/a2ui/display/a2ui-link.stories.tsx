import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UILink } from "./a2ui-link"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UILinkComponent } from "@/types/a2ui/schema"

const link = (over: Partial<A2UILinkComponent> = {}): A2UILinkComponent => ({
  id: "link",
  component: "Link",
  text: "View documentation",
  ...over,
})

// A2UILink reads resolveString from the A2UI data context, so stories mount the
// real provider (the global preview only supplies intl/theme/tooltip/router).
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/Link",
  component: A2UILink,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UILink>

export default meta
type Story = StoryObj<typeof meta>

export const Internal: Story = {
  args: makeA2UIProps(link({ text: "Back to dashboard", href: "/dashboard" })),
}

export const External: Story = {
  args: makeA2UIProps(
    link({ text: "Open Anthropic docs", href: "https://docs.anthropic.com", external: true })
  ),
}

export const AsAction: Story = {
  args: makeA2UIProps(link({ text: "Run diagnostics", action: "run-diagnostics" }), {
    onAction: fn(),
  }),
}

export const Disabled: Story = {
  args: makeA2UIProps(link({ text: "Unavailable link", href: "/locked", disabled: true })),
}
