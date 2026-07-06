import type { Meta, StoryObj } from "@storybook/nextjs"

import { SecuritySection } from "./security-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// `SecuritySection` renders the per-action biometric guard policy
// (`biometricRequiredFor`) as four toggles plus the account auto-lock <select>
// (`accountAutoLockMinutes`). Both come from the settings store and fall back to
// `DEFAULT_BIOMETRIC_GUARD` / 0 when unset.
function seedSettings(patch: Partial<AppSettings>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: patch as unknown as AppSettings })
  }
}

const meta = {
  title: "Settings/Security/SecuritySection",
  component: SecuritySection,
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
} satisfies Meta<typeof SecuritySection>

export default meta
type Story = StoryObj<typeof meta>

// Default guard policy + auto-lock off.
export const Default: Story = {}

// Every guard enabled with a 15-minute auto-lock window selected.
export const AllGuardsOn: Story = {
  beforeEach: seedSettings({
    biometricRequiredFor: {
      deletePairing: true,
      exportBackup: true,
      revealSecrets: true,
      signOut: true,
    },
    accountAutoLockMinutes: 15,
  } as unknown as Partial<AppSettings>),
}
