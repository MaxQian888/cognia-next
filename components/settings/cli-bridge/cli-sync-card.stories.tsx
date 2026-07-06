import type { Meta, StoryObj } from "@storybook/nextjs"

import { CliSyncCard } from "./cli-sync-card"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// `CliSyncCard` syncs app config/credentials into the cognia CLI home, which
// only exists in the desktop runtime. In the browser preview `isTauri()` is
// false, so the component returns `null` — there is no web surface to render.
// Documented here so the dormant-in-web behaviour is discoverable.
const meta = {
  title: "Settings/CliBridge/CliSyncCard",
  component: CliSyncCard,
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
} satisfies Meta<typeof CliSyncCard>

export default meta
type Story = StoryObj<typeof meta>

// Web/preview branch: renders nothing (`isTauri()` is false). The full card
// (status row + auto-sync toggle) appears only in the Tauri desktop build.
export const Default: Story = {}
