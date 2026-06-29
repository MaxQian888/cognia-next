import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskTemplateGallery } from "./task-template-gallery"
import { Button } from "@/components/ui/button"

// `TaskTemplateGallery` is a pure controlled dialog: it browses the static
// `TASK_TEMPLATES` catalog by category tab and emits a `CreateScheduledTaskInput`
// via `onSelect`. Stories render it open (so the grid is visible in the portal)
// and provide an interactive trigger-driven variant.
const meta = {
  title: "Scheduler/TaskTemplateGallery",
  component: TaskTemplateGallery,
  parameters: { layout: "fullscreen" },
  args: {
    onOpenChange: fn(),
    onSelect: fn(),
  },
} satisfies Meta<typeof TaskTemplateGallery>

export default meta
type Story = StoryObj<typeof meta>

// Open by default — shows the "All" category grid of templates.
export const Open: Story = {
  args: {
    open: true,
  },
}

// Interactive: a trigger button opens the dialog and category tabs filter the
// grid via the component's internal state.
export const WithTrigger: Story = {
  args: {
    open: false,
  },
  render: (args) => {
    const [open, setOpen] = useState(false)
    return (
      <div className="p-6">
        <TaskTemplateGallery
          {...args}
          open={open}
          onOpenChange={setOpen}
          trigger={<Button variant="outline">Browse templates</Button>}
        />
      </div>
    )
  },
}
