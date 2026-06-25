import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginGovernancePolicyTab } from "./plugin-governance-policy-tab"

// Plugin policy controls in the workspace Governance section: governance mode,
// signature requirement, trusted-publishers-only, auto-update, and strict
// sandboxing. The component owns its own state — it reads the persisted policy
// from localStorage (`readPolicy()`) and the security posture from the settings
// store, both of which fall back to defaults in Storybook with no seeding.
// Toggling the switches in the preview drives the live update path; there is no
// external prop surface, so this single story renders the default posture.

const meta = {
  title: "Plugins/Governance/PluginGovernancePolicyTab",
  component: PluginGovernancePolicyTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginGovernancePolicyTab>

export default meta
type Story = StoryObj<typeof meta>

// Default posture: governance=warn, signatures optional, auto-update off,
// balanced sandboxing. Flip any switch to exercise the runtime re-apply path.
export const Default: Story = {}
