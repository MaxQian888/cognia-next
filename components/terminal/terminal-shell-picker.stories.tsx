import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalShellPicker } from "./terminal-shell-picker"
import type { TerminalProfile } from "@/lib/terminal/profiles"

// Split-button "+ New" affordance. The primary button spawns the default shell;
// the chevron opens a platform-aware list (+ any saved profiles). `detectShells`
// is injected here so stories show the full platform list without a PATH scan.
const noDetect = async () => new Set<string>()

const profiles: TerminalProfile[] = [
  { id: "deploy", name: "Deploy (prod)", shell: "pwsh.exe", cwd: "D:/Project" },
  { id: "wsl", name: "WSL · Ubuntu", shell: "wsl.exe" },
]

const meta = {
  title: "Terminal/ShellPicker",
  component: TerminalShellPicker,
  parameters: { layout: "centered" },
  args: {
    onNew: fn(),
    detectShells: noDetect,
    platform: "windows",
  },
} satisfies Meta<typeof TerminalShellPicker>

export default meta
type Story = StoryObj<typeof meta>

export const Windows: Story = {}

export const Posix: Story = { args: { platform: "macos" } }

export const WithProfiles: Story = {
  args: { profiles, onNewProfile: fn() },
}
