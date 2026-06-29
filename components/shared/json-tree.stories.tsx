import type { Meta, StoryObj } from "@storybook/nextjs"

import { JsonTree } from "./json-tree"

const sample = {
  id: "art_1",
  type: "code",
  version: 3,
  runnable: true,
  tags: ["typescript", "utility"],
  metadata: { author: null, lines: 12, nested: { deep: { value: 42 } } },
  history: [
    { v: 1, note: "initial" },
    { v: 2, note: "refactor" },
  ],
}

// Collapsible JSON viewer with syntax-colored primitives. Recurses into arrays
// and objects; primitives render inline.
const meta = {
  title: "Shared/JsonTree",
  component: JsonTree,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[420px] rounded border bg-card p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof JsonTree>

export default meta
type Story = StoryObj<typeof meta>

export const Object: Story = {
  args: { value: sample },
}

export const Array: Story = {
  args: { value: [1, "two", false, null, { nested: true }] },
}

export const Primitive: Story = {
  args: { label: "answer", value: 42 },
}
