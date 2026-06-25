import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CharacterMissingBanner } from "./character-missing-banner"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"

// Inline destructive alert shown when a session points at an *overlay* character
// id (`cognia-pack:<plugin>:<pack>:<local>`) that no longer resolves — the
// contributing plugin was disabled or the local pack file deleted. It reads
// `useCharacter()` through the data adapter; the mock returns `undefined` so the
// banner renders. Plain Dexie ids stay silent (no recovery action) → null.

const missingAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const withMissing = (Story: () => React.ReactElement) => (
  <DataAdapterProvider adapter={missingAdapter}>
    <div className="w-full max-w-xl">
      <Story />
    </div>
  </DataAdapterProvider>
)

const meta = {
  title: "Chat/CharacterMissingBanner",
  component: CharacterMissingBanner,
  parameters: { layout: "padded" },
  decorators: [withMissing],
  args: {
    onPickAnother: fn(),
  },
} satisfies Meta<typeof CharacterMissingBanner>

export default meta
type Story = StoryObj<typeof meta>

// Plugin-contributed character whose plugin was uninstalled — the alert names
// the source plugin and offers the re-enable hint plus a "pick another" CTA.
export const FromPlugin: Story = {
  args: { characterId: "cognia-pack:acme-personas:team:pm" },
}

// Locally-imported pack file that was deleted — labelled as a local file.
export const FromLocalFile: Story = {
  args: { characterId: "cognia-pack:local:imported:mentor" },
}
