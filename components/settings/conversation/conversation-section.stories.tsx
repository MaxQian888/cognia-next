import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConversationSection } from "./conversation-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Settings → Conversation: auto-title generation, timeline minimap, composer
// behavior, compaction, and message-stream toggles. Reads the settings store;
// the title/timeline/label model overrides expand when their switch is on.
const meta = {
  title: "Settings/Conversation/ConversationSection",
  component: ConversationSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof ConversationSection>

export default meta
type Story = StoryObj<typeof meta>

// Defaults: title + timeline on (model-override blocks visible), label summary
// off, partial streaming on.
export const Default: Story = {}

// The Sharp style pack with no pinned composer skin. The picker must read
// "Sharp", carry Sharp's geometry (radius 0), keep the Adjust knobs live, and
// say the row is inherited — under the old fallback it claimed "Classic
// (current look)" and greyed the knobs out while the box rendered Sharp.
export const SharpPackDefault: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({ stylePack: { packId: "sharp" } }),
    })
  },
}

// Title generation and the timeline minimap both disabled → the nested model
// override editors collapse.
export const GenerationDisabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({
        conversationTitle: { enabled: false },
        conversationTimeline: { enabled: false },
      }),
    })
  },
}
