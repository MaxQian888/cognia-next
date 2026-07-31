import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { KvEditor } from "./kv-editor"

// Pure, controlled editor: the parent owns `rows` and reacts to `onChange`.
// These stories render fixed rows (onChange is a spy) to show each layout.
const meta = {
  title: "Settings/MCP/KvEditor",
  component: KvEditor,
  args: {
    label: "Environment variables",
    onChange: fn(),
    keyPlaceholder: "KEY",
    valuePlaceholder: "value",
  },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof KvEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: { rows: [] },
}

export const Populated: Story = {
  args: {
    rows: [
      { key: "DATABASE_URL", value: "postgres://localhost/app" },
      { key: "LOG_LEVEL", value: "debug" },
    ],
  },
}

export const Headers: Story = {
  args: {
    label: "Headers",
    keyPlaceholder: "Header-Name",
    valuePlaceholder: "value",
    rows: [{ key: "Authorization", value: "Bearer ••••" }],
  },
}
