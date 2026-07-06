import type { Meta, StoryObj } from "@storybook/nextjs"

import { TerminalCard } from "./terminal-card"
import { resetStores, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { makeAgentAppSettings } from "@/lib/storybook/fixtures/settings-agent"

// `TerminalCard` is the integrated-terminal settings card: default shell, font,
// scrollback, shell integration, renderer, autocomplete, plus the embedded
// launch-profiles manager and per-project override. It reads/writes
// `settings.terminal` and the project store. With null settings it shows the
// built-in defaults.
const meta = {
  title: "Settings/Terminal/TerminalCard",
  component: TerminalCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStores(useSettingsStore, useProjectStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalCard>

export default meta
type Story = StoryObj<typeof meta>

// Built-in defaults.
export const Default: Story = {}

// A configured terminal: pwsh shell, Nerd Font stack, larger scrollback.
export const Configured: Story = {
  beforeEach: () => {
    resetStores(useSettingsStore, useProjectStore)
    seedStore(useSettingsStore, {
      settings: makeAgentAppSettings({
        terminal: {
          defaultShell: "pwsh.exe",
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 14,
          scrollback: 50000,
          enableShellIntegration: true,
          cursorStyle: "bar",
        },
      }),
    })
  },
}
