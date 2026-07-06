import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UICombobox, type A2UIComboboxComponent, type A2UIComboboxOption } from "./a2ui-combobox"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const FRAMEWORKS: A2UIComboboxOption[] = [
  { value: "next", label: "Next.js" },
  { value: "remix", label: "Remix" },
  { value: "astro", label: "Astro" },
  { value: "nuxt", label: "Nuxt" },
  { value: "svelte", label: "SvelteKit", disabled: true },
]

const combobox = (over: Partial<A2UIComboboxComponent> = {}): A2UIComboboxComponent => ({
  id: "framework",
  component: "Combobox",
  value: "",
  options: FRAMEWORKS,
  ...over,
})

// `A2UICombobox` reads value + options through `useA2UIData()`, which needs an
// `A2UIProvider`. Literal values/options resolve directly (no seeded surface).
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/Combobox",
  component: A2UICombobox,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UICombobox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(combobox({ placeholder: "Select a framework" }), { onDataChange: fn() }),
}

export const WithValue: Story = {
  args: makeA2UIProps(combobox({ label: "Framework", value: "remix" })),
}

export const WithLabel: Story = {
  args: makeA2UIProps(combobox({ label: "Preferred framework" })),
}

export const CustomPlaceholders: Story = {
  args: makeA2UIProps(
    combobox({
      label: "Framework",
      placeholder: "Pick one…",
      searchPlaceholder: "Type to filter frameworks",
    })
  ),
}

export const EmptyOptions: Story = {
  args: makeA2UIProps(
    combobox({ label: "Framework", options: [], emptyText: "No frameworks available" })
  ),
}
