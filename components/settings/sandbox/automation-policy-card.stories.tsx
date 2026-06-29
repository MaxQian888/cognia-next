import type { Meta, StoryObj } from "@storybook/nextjs"

import { AutomationPolicyCard } from "./automation-policy-card"

// The card hydrates its draft from `getAutomationPolicy()`, which returns the
// empty `DEFAULT_AUTOMATION_POLICY` in the Storybook browser (web mode, no Rust
// backend). It then owns the policy as internal state, so the four list editors
// (process names / window titles / URL patterns / forbidden screen regions)
// render with their empty-note and "Add" affordances — fully interactive
// without any backend. Edits debounce-save to a no-op IPC call.
const meta = {
  title: "Settings/Sandbox/AutomationPolicyCard",
  component: AutomationPolicyCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[600px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutomationPolicyCard>

export default meta
type Story = StoryObj<typeof meta>

// Empty policy — every list shows its empty note + "Add" button.
export const Default: Story = {}
