import type { Meta, StoryObj } from "@storybook/nextjs"

import { MemorySection } from "./memory-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"
import { type MemoryConfig } from "@/types/memory/memory"

// Store-reading: the long-term memory subsystem config comes from
// `resolveMemoryConfig(settings.memory)`, so an unseeded store renders every
// default (enabled). Seed a partial `memory` blob to vary the toggles. Reset
// the settings store between stories.
function seed(memory?: Partial<MemoryConfig>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings(memory ? { memory: memory as MemoryConfig } : {}),
    })
  }
}

const meta = {
  title: "Settings/Sections/MemorySection",
  component: MemorySection,
  parameters: { layout: "padded" },
  beforeEach: seed(),
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemorySection>

export default meta
type Story = StoryObj<typeof meta>

// Defaults — memory enabled, auto-extract on, global scope, hybrid retrieval.
export const Default: Story = {}

// Master switch off — the dependent toggles disable.
export const Disabled: Story = {
  beforeEach: seed({ enabled: false }),
}

// Cloud embedding allowed + character-scoped, larger retrieval window.
export const CloudEmbedding: Story = {
  beforeEach: seed({
    enabled: true,
    allowCloudEmbedding: true,
    scopeDefault: "character",
    retrievalTopK: 16,
    maxActivePerScope: 1000,
  }),
}
