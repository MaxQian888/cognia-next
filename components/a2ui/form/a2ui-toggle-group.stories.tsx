import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  A2UIToggleGroup,
  type A2UIToggleGroupComponent,
  type A2UIToggleGroupOption,
} from "./a2ui-toggle-group"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const FORMATTING: A2UIToggleGroupOption[] = [
  { value: "bold", label: "Bold" },
  { value: "italic", label: "Italic" },
  { value: "underline", label: "Underline" },
  { value: "strike", label: "Strike", disabled: true },
]

const ALIGNMENT: A2UIToggleGroupOption[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
]

const toggleGroup = (over: Partial<A2UIToggleGroupComponent> = {}): A2UIToggleGroupComponent => ({
  id: "formatting",
  component: "ToggleGroup",
  options: FORMATTING,
  value: [],
  ...over,
})

// `A2UIToggleGroup` reads its selected `value` array through `useA2UIData()`,
// which needs an `A2UIProvider`. Literal arrays resolve directly.
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/ToggleGroup",
  component: A2UIToggleGroup,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIToggleGroup>

export default meta
type Story = StoryObj<typeof meta>

export const MultipleEmpty: Story = {
  args: makeA2UIProps(toggleGroup(), { onDataChange: fn() }),
}

export const MultipleSelected: Story = {
  args: makeA2UIProps(toggleGroup({ label: "Formatting", value: ["bold", "italic"] })),
}

export const Single: Story = {
  args: makeA2UIProps(
    toggleGroup({
      id: "align",
      label: "Alignment",
      options: ALIGNMENT,
      multiple: false,
      value: ["center"],
    })
  ),
}

export const Large: Story = {
  args: makeA2UIProps(toggleGroup({ label: "Formatting", size: "lg", value: ["underline"] })),
}

export const WithLabel: Story = {
  args: makeA2UIProps(toggleGroup({ label: "Text style" })),
}
