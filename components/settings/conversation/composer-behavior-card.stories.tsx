import type { Meta, StoryObj } from "@storybook/nextjs"

import { ComposerBehaviorCard } from "./composer-behavior-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Non-LLM composer/send-box behavior toggles. Reads `settings.composerBehavior`
// from the store; every switch defaults ON when the block is absent.
const meta = {
  title: "Settings/Conversation/ComposerBehaviorCard",
  component: ComposerBehaviorCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof ComposerBehaviorCard>

export default meta
type Story = StoryObj<typeof meta>

// Absent block → all five toggles default ON.
export const AllDefaults: Story = {}

// A mixed configuration with several behaviors turned off.
export const Customized: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({
        composerBehavior: {
          sendOnEnter: false,
          clearAfterSend: true,
          autoScrollOnStream: false,
          inputHistoryRecall: true,
          persistDrafts: false,
        },
      }),
    })
  },
}
