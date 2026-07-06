import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIButton } from "./a2ui-button"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIButtonComponent } from "@/types/a2ui/schema"

const button = (over: Partial<A2UIButtonComponent> = {}): A2UIButtonComponent => ({
  id: "button",
  component: "Button",
  text: "Submit",
  action: "submit",
  ...over,
})

// Form renderers read bound values through useA2UIData(), which requires an
// A2UIProvider in the tree. Literal (non-`{ path }`) descriptor values resolve
// directly, so an empty surface is enough to render every state.
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/Button",
  component: A2UIButton,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(button(), { onAction: fn() }),
}

export const Secondary: Story = {
  args: makeA2UIProps(button({ text: "Cancel", variant: "secondary" })),
}

export const Destructive: Story = {
  args: makeA2UIProps(button({ text: "Delete", action: "delete", variant: "destructive" })),
}

export const Outline: Story = {
  args: makeA2UIProps(button({ text: "Preview", variant: "outline" })),
}

export const Ghost: Story = {
  args: makeA2UIProps(button({ text: "Dismiss", variant: "ghost" })),
}

export const Link: Story = {
  args: makeA2UIProps(button({ text: "Learn more", variant: "link" })),
}

export const Loading: Story = {
  args: makeA2UIProps(button({ text: "Saving…", loading: true })),
}

export const Disabled: Story = {
  args: makeA2UIProps(button({ text: "Unavailable", disabled: true })),
}
