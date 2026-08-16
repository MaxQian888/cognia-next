import type { Meta, StoryObj } from "@storybook/nextjs"

import { WallpaperTab } from "./wallpaper-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"
import { DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"

// Appearance → Wallpaper tab: gallery + uploader + gradient builder + the
// placement / readability adjustments and the wallpaper sampler. Reads
// flattened store fields (background, wallpapers), defaulted when settings is
// empty.
//
// The panel's multi-column layouts size off `@container/appearance-pane`, which
// `appearance-section.tsx` owns — the decorator below stands in for it so these
// stories show the same two-column placement row the real settings pane does.
const meta = {
  title: "Settings/Appearance/Tabs/WallpaperTab",
  component: WallpaperTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="@container/appearance-pane">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof WallpaperTab>

export default meta
type Story = StoryObj<typeof meta>

/** Nothing picked yet — every adjustment below the gallery is inert. */
export const Default: Story = {}

/**
 * A built-in gradient active: the adjustments unlock, the sampler reports the
 * extracted accent/secondary, and the contrast chip switches from its blind
 * estimate to a measured one.
 */
export const WithActiveWallpaper: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    // The panel reads the store's *flattened* `background`, which is recomputed
    // from `settings` only inside the store's own actions — so a story has to
    // seed both.
    const background = {
      ...DEFAULT_BACKGROUND_SETTINGS,
      enabled: true,
      activeId: "preset-gradient-neon-city",
      opacity: 0.55,
      blurPx: 6,
    }
    seedStore(useSettingsStore, {
      loaded: true,
      settings: { ...makeAppSettings(), background },
      background,
    })
  },
}

/** A `contain` fit anchored bottom-right, so the focal grid is live. */
export const ContainWithFocalPoint: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    const background = {
      ...DEFAULT_BACKGROUND_SETTINGS,
      enabled: true,
      activeId: "preset-gradient-sakura-sky",
      position: "contain" as const,
      focalX: 100,
      focalY: 100,
    }
    seedStore(useSettingsStore, {
      loaded: true,
      settings: { ...makeAppSettings(), background },
      background,
    })
  },
}
