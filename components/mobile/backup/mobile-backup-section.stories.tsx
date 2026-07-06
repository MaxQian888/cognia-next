import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileBackupSection } from "./mobile-backup-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { seedDb } from "@/lib/storybook/seed-db"
import { useSettingsStore } from "@/stores/settings"

// Mobile backup section: encrypted export, import, auto-backup toggle, WebDAV
// sync card, and history. Reads `useSettingsStore` (biometric gate) + the
// `backupHistory` Dexie table. Off-Capacitor, `detectNativePlatform()` is not
// "mobile" so the web-mode note shows; history is empty on a fresh DB.
const meta = {
  title: "Mobile/Backup/MobileBackupSection",
  component: MobileBackupSection,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    resetStore(useSettingsStore)
    await seedDb(async () => {})
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileBackupSection>

export default meta
type Story = StoryObj<typeof meta>

/** Fresh state — empty passphrase, auto-backup off, no history yet. */
export const Default: Story = {}
