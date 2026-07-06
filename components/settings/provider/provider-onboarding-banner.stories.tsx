import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { ProviderOnboardingBanner } from "./provider-onboarding-banner"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"

// Store + Dexie component: reads the flat `providerOnboardingDismissed` flag
// from `useSettingsStore` and the cached models.dev catalog via a Dexie
// `useLiveQuery` (empty in Storybook — the catalog summary falls back to
// "never"). When dismissed it renders nothing, so the default story seeds the
// flag to false.
const meta = {
  title: "Settings/Provider/ProviderOnboardingBanner",
  component: ProviderOnboardingBanner,
  parameters: { layout: "padded" },
  args: { onScrollToProvider: fn() },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { providerOnboardingDismissed: false })
  },
} satisfies Meta<typeof ProviderOnboardingBanner>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// Dismissed → component returns null and nothing renders.
export const Dismissed: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { providerOnboardingDismissed: true })
  },
}
