import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowsSection } from "./workflows-section"

// `WorkflowsSection` is the 5-tab shell (Library / Runs / Templates / Defaults /
// Audit). The active tab is mirrored into `?wfTab=` via the App Router; the
// preview's router mocks keep `router.replace` a no-op, so the default Library
// tab renders.
const meta = {
  title: "Settings/Workflows/WorkflowsSection",
  component: WorkflowsSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] overflow-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowsSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
