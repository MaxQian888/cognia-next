import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DiscoverSearch } from "./discover-search"

// Controlled search input with a leading icon and a clear button that appears
// only when `value` is non-empty.
const meta = {
  title: "Mobile/Discover/DiscoverSearch",
  component: DiscoverSearch,
  parameters: { layout: "padded" },
  args: { value: "", onChange: fn() },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverSearch>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const WithValue: Story = {
  args: { value: "research" },
}

export const CustomPlaceholder: Story = {
  args: { placeholder: "Search personas…" },
}
