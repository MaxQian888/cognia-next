import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConversationSearchInput } from "./conversation-search-input"

// Pure controlled input — `value` is the debounced text owned by the parent,
// `onDebouncedChange` fires after `debounceMs`. Esc / × clear the field.
const meta = {
  title: "Inbox/ConversationSearchInput",
  component: ConversationSearchInput,
  args: { value: "", onDebouncedChange: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConversationSearchInput>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const WithText: Story = { args: { value: "billing issue" } }
