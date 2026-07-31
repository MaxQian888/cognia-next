import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"

import { A2UIText } from "./a2ui-text"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import type { A2UITextComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const text = (over: Partial<A2UITextComponent> = {}): A2UITextComponent => ({
  id: "text",
  component: "Text",
  text: "The quick brown fox jumps over the lazy dog.",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/Text",
  component: A2UIText,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIText>

export default meta
type Story = StoryObj<typeof meta>

export const Body: Story = { args: makeA2UIProps(text()) }

export const Heading1: Story = {
  args: makeA2UIProps(text({ text: "Quarterly business review", variant: "heading1" })),
}

export const Heading2: Story = {
  args: makeA2UIProps(text({ text: "Revenue highlights", variant: "heading2" })),
}

export const Heading3: Story = {
  args: makeA2UIProps(text({ text: "Regional breakdown", variant: "heading3" })),
}

export const Heading4: Story = {
  args: makeA2UIProps(text({ text: "North America", variant: "heading4" })),
}

export const Caption: Story = {
  args: makeA2UIProps(text({ text: "Last updated 2 minutes ago", variant: "caption" })),
}

export const Code: Story = {
  args: makeA2UIProps(text({ text: "npm install @cognia/a2ui", variant: "code" })),
}

export const Label: Story = {
  args: makeA2UIProps(text({ text: "Email address", variant: "label" })),
}

export const Centered: Story = {
  args: makeA2UIProps(text({ text: "Centered headline", variant: "heading2", align: "center" })),
}

export const RightAligned: Story = {
  args: makeA2UIProps(text({ text: "Aligned to the right", align: "right" })),
}

export const Colored: Story = {
  args: makeA2UIProps(text({ text: "Brand-colored text", color: "#6366f1" })),
}

export const LongParagraph: Story = {
  args: makeA2UIProps(
    text({
      text: "A2UI lets an agent describe rich interactive surfaces declaratively. The renderer maps each descriptor onto a typed React component, resolving data-bound values from the surface data model at render time.",
    })
  ),
}
