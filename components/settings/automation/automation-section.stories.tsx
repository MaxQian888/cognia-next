import type { Meta, StoryObj } from "@storybook/nextjs"

import { AutomationSection } from "./automation-section"

// Composite five-tab section (Overview / Permissions / Whitelist / Audit /
// Inspector / Sandboxes), driven by the `?autoTab=` query param via the App
// Router mocks the Storybook preview supplies. The automation engine only runs
// under Tauri, so the Overview tab shows its "requires the desktop runtime"
// alert in the browser; the Audit tab reads the (empty) Dexie table.
const meta = {
  title: "Settings/Automation/AutomationSection",
  component: AutomationSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutomationSection>

export default meta
type Story = StoryObj<typeof meta>

// Default tab (Overview) — web branch alert under the tab bar + header.
export const Default: Story = {}
