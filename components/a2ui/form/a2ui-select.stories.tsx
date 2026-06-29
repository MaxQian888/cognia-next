import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UISelect } from "./a2ui-select"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UISelectComponent, A2UISelectOption } from "@/types/a2ui/schema"

const COUNTRIES: A2UISelectOption[] = [
  { value: "us", label: "United States" },
  { value: "ca", label: "Canada" },
  { value: "gb", label: "United Kingdom" },
  { value: "de", label: "Germany" },
  { value: "jp", label: "Japan", disabled: true },
]

const select = (over: Partial<A2UISelectComponent> = {}): A2UISelectComponent => ({
  id: "country",
  component: "Select",
  value: "",
  options: COUNTRIES,
  ...over,
})

// `A2UISelect` reads value/error/disabled through `useA2UIData()`, which needs an
// `A2UIProvider`. Literal values resolve directly without a seeded surface.
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/Select",
  component: A2UISelect,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UISelect>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(select({ placeholder: "Choose a country" }), { onDataChange: fn() }),
}

export const WithValue: Story = {
  args: makeA2UIProps(select({ label: "Country", value: "ca" })),
}

export const WithLabel: Story = {
  args: makeA2UIProps(select({ label: "Country", required: true })),
}

export const WithHelperText: Story = {
  args: makeA2UIProps(
    select({ label: "Country", helperText: "Used for billing and tax purposes." })
  ),
}

export const WithError: Story = {
  args: makeA2UIProps(select({ label: "Country", error: "Please select a country." })),
}

export const Disabled: Story = {
  args: makeA2UIProps(select({ label: "Country", value: "us", disabled: true })),
}

export const EmptyOptions: Story = {
  args: makeA2UIProps(select({ label: "Country", options: [], placeholder: "No options yet" })),
}
