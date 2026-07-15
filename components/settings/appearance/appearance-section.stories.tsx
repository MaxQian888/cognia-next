import type { Meta, StoryObj } from "@storybook/nextjs"

import { AppearanceSection } from "./appearance-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Master/detail shell for the Appearance section: a grouped nav (theme / auto
// / custom / library — wallpaper / typography / components / personalization —
// a11y / advanced / plugins) beside one panel. The active panel is URL-driven;
// App Router mocks default it to "theme". Reads the settings store, so it is
// seeded with a loaded snapshot.
//
// The section is a member of the settings shell's `FILL_HEIGHT_SECTIONS` and
// sizes to its frame, so the decorator supplies the height that the real shell
// would — without it `h-full min-h-0` collapses and the story renders empty.
const meta = {
  title: "Settings/Appearance/AppearanceSection",
  component: AppearanceSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-screen p-4">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof AppearanceSection>

export default meta
type Story = StoryObj<typeof meta>

// Default → the theme panel.
export const Default: Story = {}
