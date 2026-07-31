import type { Meta, StoryObj } from "@storybook/nextjs"

import { TerminalProfiles } from "./terminal-profiles"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAgentAppSettings } from "@/lib/storybook/fixtures/settings-agent"

// `TerminalProfiles` is the launch-profiles manager (Windows-Terminal style):
// named shell presets (name + shell + cwd) with a default-profile picker,
// persisted to `settings.terminal.profiles` / `defaultProfileId`. Inline-
// editable rows; the empty state invites adding the first profile.
const meta = {
  title: "Settings/Terminal/TerminalProfiles",
  component: TerminalProfiles,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalProfiles>

export default meta
type Story = StoryObj<typeof meta>

// No profiles yet — empty state + add affordance.
export const Default: Story = {}

// A couple of named profiles, one marked as the default.
export const WithProfiles: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAgentAppSettings({
        terminal: {
          defaultProfileId: "prof-pwsh",
          profiles: [
            { id: "prof-pwsh", name: "PowerShell", shell: "pwsh.exe", cwd: "" },
            { id: "prof-bash", name: "WSL bash", shell: "/bin/bash", cwd: "/home/dev" },
          ],
        },
      }),
    })
  },
}
