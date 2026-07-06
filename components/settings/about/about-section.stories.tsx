import type { Meta, StoryObj } from "@storybook/nextjs"

import { AboutSection } from "./about-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"

// Composition of the whole About page: hero + version/build, system
// diagnostics, updates, what's new, resources, and legal/credits cards. Each
// child platform-gates itself, so in Storybook (web) they render their
// web/fallback branches (e.g. diagnostics show "unavailable", updates show the
// desktop-only notice). `UpdateCard` reads `useSettingsStore`, so the store is
// reset between stories.
const meta = {
  title: "Settings/About/AboutSection",
  component: AboutSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof AboutSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
