import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { StateCard } from "./state-card"

// The compound exposes four sub-components; the meta targets the Empty leaf and
// each story renders the relevant variant.
const meta = {
  title: "Inbox/StateCard",
  component: StateCard.Empty,
  parameters: { layout: "padded" },
} satisfies Meta<typeof StateCard.Empty>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => <StateCard.Empty />,
}

export const Loading: Story = {
  render: () => <StateCard.Loading rows={6} />,
}

export const Error: Story = {
  render: () => (
    <StateCard.Error
      onRetry={fn()}
      stackTrace={
        "TypeError: Cannot read properties of undefined (reading 'id')\n  at InboxList (inbox-list.tsx:42:18)\n  at renderWithHooks (react-dom.js:1234)"
      }
    />
  ),
}

export const Syncing: Story = {
  render: () => <StateCard.Syncing />,
}
