import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkspaceTrustSection } from "./workspace-trust-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// `WorkspaceTrustSection` reads the two trust toggles from `useSettingsStore`
// and lists trusted folders from Dexie (`listTrustedWorkspaces`). With an empty
// Storybook IndexedDB the ledger renders its "no trusted folders" empty state,
// so the toggles are the interesting surface to seed.
function seedTrust(patch: Partial<AppSettings>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: patch as unknown as AppSettings })
  }
}

const meta = {
  title: "Settings/WorkspaceTrust/WorkspaceTrustSection",
  component: WorkspaceTrustSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceTrustSection>

export default meta
type Story = StoryObj<typeof meta>

// Default: trust enabled (the `!== false` default), prompt-on-switch off.
export const Default: Story = {}

// Prompt-on-switch enabled — the second toggle is no longer disabled.
export const PromptOnSwitch: Story = {
  beforeEach: seedTrust({ workspaceTrust: { enabled: true, promptOnSwitch: true } }),
}

// Trust disabled — the prompt-on-switch toggle is disabled in this state.
export const Disabled: Story = {
  beforeEach: seedTrust({ workspaceTrust: { enabled: false, promptOnSwitch: false } }),
}
