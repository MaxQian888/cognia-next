import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UISlider } from "./a2ui-slider"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UISliderComponent } from "@/types/a2ui/schema"

const slider = (over: Partial<A2UISliderComponent> = {}): A2UISliderComponent => ({
  id: "slider",
  component: "Slider",
  value: 50,
  label: "Volume",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/Slider",
  component: A2UISlider,
  decorators: [withA2UI],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UISlider>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(slider(), { onDataChange: fn() }),
}

export const WithValueReadout: Story = {
  args: makeA2UIProps(slider({ value: 72, showValue: true }), { onDataChange: fn() }),
}

export const CustomRange: Story = {
  args: makeA2UIProps(
    slider({ label: "Rating", value: 7.5, min: 0, max: 10, step: 0.5, showValue: true })
  ),
}

export const Empty: Story = {
  args: makeA2UIProps(slider({ label: "Brightness", value: 0, min: 0, max: 100, showValue: true })),
}

export const NoLabel: Story = {
  args: makeA2UIProps(slider({ label: undefined, value: 30 })),
}

export const Disabled: Story = {
  args: makeA2UIProps(slider({ value: 40, disabled: true, showValue: true })),
}
