import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIFormGroup, type A2UIFormGroupComponent } from "./a2ui-form-group"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const formGroup = (over: Partial<A2UIFormGroupComponent> = {}): A2UIFormGroupComponent => ({
  id: "profile",
  component: "FormGroup",
  children: ["firstName", "lastName", "email"],
  ...over,
})

// `A2UIFormGroup` renders children through `A2UIChildRenderer`, which calls
// `useA2UIContext()` and needs an `A2UIProvider`. With no seeded surface the
// child ids resolve to nothing, so these stories exercise the group chrome
// (legend / description / layout) — see the prompt's container guidance.
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/FormGroup",
  component: A2UIFormGroup,
  decorators: [withA2UI],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIFormGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(formGroup({ legend: "Profile" }), { onAction: fn() }),
}

export const WithDescription: Story = {
  args: makeA2UIProps(
    formGroup({
      legend: "Contact details",
      description: "We'll only use this to reach you about your account.",
    })
  ),
}

export const Required: Story = {
  args: makeA2UIProps(formGroup({ legend: "Billing address", required: true })),
}

export const HorizontalLayout: Story = {
  args: makeA2UIProps(formGroup({ legend: "Filters", layout: "horizontal" })),
}

export const GridLayout: Story = {
  args: makeA2UIProps(
    formGroup({
      legend: "Shipping",
      layout: "grid",
      columns: 3,
      children: ["street", "city", "state", "zip", "country"],
    })
  ),
}

export const Empty: Story = {
  args: makeA2UIProps(formGroup({ legend: "Empty group", children: [] })),
}
