import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowLibraryEmpty } from "./workflow-library-empty"

const meta = {
  title: "Workflow/LibraryEmpty",
  component: WorkflowLibraryEmpty,
  parameters: { layout: "centered" },
  args: { onCreate: fn(), onClearFilters: fn() },
} satisfies Meta<typeof WorkflowLibraryEmpty>

export default meta
type Story = StoryObj<typeof meta>

// First-run library root with a create CTA.
export const Root: Story = {
  args: { variant: "root" },
}

// An empty folder.
export const Folder: Story = {
  args: { variant: "folder" },
}

// Filters matched nothing — offers a clear-filters action.
export const Filtered: Story = {
  args: { variant: "filtered" },
}
