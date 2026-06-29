import type { Meta, StoryObj } from "@storybook/nextjs"

import { TriggerButton } from "./trigger-button"

// Manual-trigger button. Pure props — tapping enqueues a
// `workflow_trigger_manual` outbound job + a haptic (no-ops off the Capacitor
// shell), so the static render is the meaningful surface.
const meta = {
  title: "Mobile/Workflow/TriggerButton",
  component: TriggerButton,
  parameters: { layout: "centered" },
  args: { workflowId: "wf-daily", workflowName: "Daily standup digest" },
} satisfies Meta<typeof TriggerButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const FullWidth: Story = {
  args: { className: "w-full" },
  decorators: [
    (Story) => (
      <div className="w-[280px]">
        <Story />
      </div>
    ),
  ],
}
