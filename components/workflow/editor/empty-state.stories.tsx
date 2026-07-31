import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { EditorEmptyState } from "./empty-state"

const meta = {
  title: "Workflow/EditorEmptyState",
  component: EditorEmptyState,
  parameters: { layout: "fullscreen" },
  // The component is `absolute inset-0` — give it a positioned, sized host so
  // it centers like it does over the real canvas.
  decorators: [
    (Story) => (
      <div className="relative h-[420px] w-full rounded-md border bg-background">{Story()}</div>
    ),
  ],
  args: { onAddNode: fn() },
} satisfies Meta<typeof EditorEmptyState>

export default meta
type Story = StoryObj<typeof meta>

// Blank canvas with the "add manual trigger" shortcut.
export const Default: Story = {}

// No add-node callback wired — only the "browse templates" link shows.
export const WithoutAddButton: Story = {
  args: { onAddNode: undefined },
}
