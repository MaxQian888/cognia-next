import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ModelAliasEditor } from "./model-alias-editor"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeModelMapping,
  makeModelMappingEntry,
  makeProviderSettingsMap,
} from "@/lib/storybook/fixtures/settings-provider"
import type { AppSettings } from "@/lib/claude/types"

// Dialog editor for a single model-alias mapping. Edits a local draft and
// persists through `useSettingsStore.upsertModelMapping`. Provider options for
// the per-entry pickers come from the settings store. Authored OPEN.
const meta = {
  title: "Settings/Provider/Routing/ModelAliasEditor",
  component: ModelAliasEditor,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: { providerSettings: makeProviderSettingsMap() } as AppSettings,
    })
  },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof ModelAliasEditor>

export default meta
type Story = StoryObj<typeof meta>

// Creating a brand-new alias — empty draft, single blank entry, save disabled.
export const CreateNew: Story = {
  args: { mapping: null },
}

// Editing an existing weighted mapping with a populated fallback chain.
export const EditExisting: Story = {
  args: {
    mapping: makeModelMapping({
      alias: "balanced",
      distribution: "weighted",
      providers: [
        makeModelMappingEntry({
          providerId: "anthropic",
          modelId: "claude-sonnet-4-6",
          weight: 70,
        }),
        makeModelMappingEntry({ providerId: "openai", modelId: "gpt-4.1", weight: 30 }),
      ],
    }),
  },
}
