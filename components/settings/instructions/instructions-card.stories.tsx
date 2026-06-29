import type { Meta, StoryObj } from "@storybook/nextjs"

import { InstructionsCard } from "./instructions-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// `InstructionsCard` hydrates its local form state from `settings.instructions`
// in an effect. The `mode` <select>, global-path <input>, and extra-paths
// <textarea> only become editable while the master "enabled" switch is on.
function seedSettings(patch: Partial<AppSettings>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: patch as unknown as AppSettings })
  }
}

const meta = {
  title: "Settings/Instructions/InstructionsCard",
  component: InstructionsCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InstructionsCard>

export default meta
type Story = StoryObj<typeof meta>

// No persisted config — the card uses its built-in defaults (enabled, layered).
export const Default: Story = {}

// A fully-configured instruction set: nearest mode, a global path, and two
// extra include paths.
export const Configured: Story = {
  beforeEach: seedSettings({
    instructions: {
      enabled: true,
      mode: "nearest",
      includeGlobal: true,
      globalPath: "~/.config/cognia/CLAUDE.md",
      loadProjectAgents: true,
      extraPaths: ["docs/AGENTS.md", "packages/core/CLAUDE.md"],
    },
  } as unknown as Partial<AppSettings>),
}

// Disabled — all the nested controls render in their disabled state.
export const Disabled: Story = {
  beforeEach: seedSettings({
    instructions: { enabled: false, mode: "layered", includeGlobal: false },
  } as unknown as Partial<AppSettings>),
}
