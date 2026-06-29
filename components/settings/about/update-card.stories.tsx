import type { Meta, StoryObj } from "@storybook/nextjs"

import { UpdateCard } from "./update-card"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"

// Store-reading + Tauri-branching card. It reads `settings.updates.autoCheck`
// from `useSettingsStore` and gates the updater UI on `isTauri()`. In Storybook
// (web) `isTauri()` is false, so this stories the web/fallback path: a
// "updates ship via desktop" notice and a disabled "check for updates" button —
// the auto-check toggle only mounts on desktop. The settings store is reset
// between stories so no state leaks in.
const meta = {
  title: "Settings/About/UpdateCard",
  component: UpdateCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof UpdateCard>

export default meta
type Story = StoryObj<typeof meta>

/** Web/fallback path: desktop-only notice + disabled check button. */
export const Default: Story = {}
