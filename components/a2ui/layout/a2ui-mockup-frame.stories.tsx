import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIMockupFrame } from "./a2ui-mockup-frame"
import type { A2UIMockupFrameComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild } from "@/lib/storybook/fixtures/a2ui-surface"

const mockup = (over: Partial<A2UIMockupFrameComponent> = {}): A2UIMockupFrameComponent => ({
  id: "mockup",
  component: "MockupFrame",
  title: "Dashboard preview",
  caption: "Generated layout, ready for review",
  children: ["screen-header", "screen-body"],
  ...over,
})

const renderChild = (id: string) =>
  placeholderChild(id, id === "screen-header" ? "Header bar with navigation" : "Main content area")

const meta = {
  title: "A2UI/Layout/MockupFrame",
  component: A2UIMockupFrame,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIMockupFrame>

export default meta
type Story = StoryObj<typeof meta>

export const Browser: Story = {
  args: makeA2UIProps(mockup({ frameStyle: "browser" }), { renderChild }),
}

export const Mobile: Story = {
  args: makeA2UIProps(mockup({ frameStyle: "mobile" }), { renderChild }),
}

export const Desktop: Story = {
  args: makeA2UIProps(mockup({ frameStyle: "desktop" }), { renderChild }),
}
