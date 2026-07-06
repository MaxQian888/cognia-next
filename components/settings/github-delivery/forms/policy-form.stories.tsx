import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PolicyForm } from "./policy-form"
import { DEFAULT_GH_POLICY, type GhPolicy } from "@/lib/github/types"

// Reusable GhPolicy editor used by the Policies tab + per-repo override drawer.
// Pure: keeps draft state locally and hands the result to `onSave`. `value`
// null seeds from DEFAULT_GH_POLICY.
const customPolicy: GhPolicy = {
  ...DEFAULT_GH_POLICY,
  requireGreenCi: false,
  maxDailyMerges: 10,
}

const meta = {
  title: "Settings/GithubDelivery/PolicyForm",
  component: PolicyForm,
  parameters: { layout: "padded" },
  args: { value: null, onSave: fn(), onReset: fn() },
} satisfies Meta<typeof PolicyForm>

export default meta
type Story = StoryObj<typeof meta>

// No policy configured → seeded from defaults (global form).
export const NewPolicy: Story = {
  args: { value: null },
}

// An existing policy in the per-repo drawer with "Reset to global" shown.
export const RepoOverride: Story = {
  args: { value: customPolicy, showResetToGlobal: true },
}

// Disabled while a save is in flight.
export const Disabled: Story = {
  args: { value: customPolicy, disabled: true },
}
