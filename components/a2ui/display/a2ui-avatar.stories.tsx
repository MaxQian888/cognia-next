import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"

import { A2UIAvatar, type A2UIAvatarComponent } from "./a2ui-avatar"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const avatar = (over: Partial<A2UIAvatarComponent> = {}): A2UIAvatarComponent => ({
  id: "avatar",
  component: "Avatar",
  fallback: "AC",
  ...over,
})

// A2UIAvatar resolves `src` through the A2UI data context.
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/Avatar",
  component: A2UIAvatar,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIAvatar>

export default meta
type Story = StoryObj<typeof meta>

export const Image: Story = {
  args: makeA2UIProps(
    avatar({ src: "https://i.pravatar.cc/120?img=12", alt: "Ada Lovelace", fallback: "AL" })
  ),
}

export const Fallback: Story = {
  args: makeA2UIProps(avatar({ fallback: "JD" })),
}

export const Small: Story = {
  args: makeA2UIProps(avatar({ size: "sm", fallback: "S" })),
}

export const Large: Story = {
  args: makeA2UIProps(avatar({ size: "lg", fallback: "L" })),
}

export const BrokenImage: Story = {
  args: makeA2UIProps(
    avatar({ src: "https://example.com/does-not-exist.png", alt: "Missing", fallback: "?" })
  ),
}
