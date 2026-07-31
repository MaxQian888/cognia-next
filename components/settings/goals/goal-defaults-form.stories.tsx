import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalDefaultsForm } from "./goal-defaults-form"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAgentAppSettings } from "@/lib/storybook/fixtures/settings-agent"

// `GoalDefaultsForm` edits `AppSettings.goals` — the per-user defaults applied
// to every new goal (budgets, judge customization, pacing + quiet hours). With
// null settings it falls back to `DEFAULT_GOAL_CONFIG`; the Save button stays
// disabled until the draft diverges from the persisted defaults.
const meta = {
  title: "Settings/Goals/GoalDefaultsForm",
  component: GoalDefaultsForm,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalDefaultsForm>

export default meta
type Story = StoryObj<typeof meta>

// Library defaults.
export const Default: Story = {}

// Custom budgets, a dedicated judge model, manual pacing + quiet hours on.
export const Configured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAgentAppSettings({
        goals: {
          maxTurns: 40,
          maxTokens: 500000,
          maxJudgeFailures: 5,
          timeoutMs: 1_800_000,
          startPaused: true,
          judgeModel: "claude-haiku-4-5",
          judgeTemperature: 0.2,
          manualContinue: true,
          continuationIntervalMs: 30000,
          quietHours: { from: "22:00", to: "07:00", tz: "UTC" },
        },
      }),
    })
  },
}
