import type { Meta, StoryObj } from "@storybook/nextjs"

import { GitSection } from "./git-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// `GitSection` reads `gitSettings.commitMessageAI` from the settings store. When
// the AI commit toggle is on it reveals the Conventional Commits switch, custom
// instructions, and the provider/model override row (the provider <Select>
// options come from `providerSettings` + `customProviders`).
function seedSettings(patch: Partial<AppSettings>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: patch as unknown as AppSettings })
  }
}

const meta = {
  title: "Settings/SourceControl/GitSection",
  component: GitSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GitSection>

export default meta
type Story = StoryObj<typeof meta>

// Falls back to `DEFAULT_GIT_SETTINGS` — AI commit generation enabled by default.
export const Default: Story = {}

// AI enabled with providers configured + a custom instruction filled in, so the
// nested controls (Conventional Commits, instructions, provider/model) render.
export const Configured: Story = {
  beforeEach: seedSettings({
    providerSettings: { anthropic: {}, openai: {} },
    gitSettings: {
      commitMessageAI: {
        enabled: true,
        conventionalCommits: true,
        customInstructions: "Reference the ticket id in the footer.",
        providerOverride: "anthropic",
        model: "claude-sonnet-4-5",
      },
    },
  } as unknown as Partial<AppSettings>),
}

// AI commit generation switched off — only the master toggle shows.
export const Disabled: Story = {
  beforeEach: seedSettings({
    gitSettings: { commitMessageAI: { enabled: false } },
  } as unknown as Partial<AppSettings>),
}
