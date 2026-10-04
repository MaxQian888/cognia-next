import type { Meta, StoryObj } from "@storybook/nextjs"

import { TerminalSection } from "./terminal-section"
import { resetStores, seedStore } from "@/lib/storybook/seed-stores"
import { makeAgentAppSettings } from "@/lib/storybook/fixtures/settings-agent"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"

// `TerminalSection` is Settings → Terminal: a topic rail and one panel, with the
// panel in `?terminalPanel=`. Reset the settings + project stores so every
// panel starts from a clean slate.
const meta = {
  title: "Settings/Terminal/TerminalSection",
  component: TerminalSection,
  parameters: { layout: "padded", nextjs: { appDirectory: true } },
  beforeEach: () => {
    resetStores(useSettingsStore, useProjectStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[760px] w-[1100px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

const SSH_HOSTS: SshHostProfile[] = [
  {
    id: "ssh-1",
    name: "Bastion",
    host: "jump.example.com",
    port: 22,
    username: "ops",
    authMethod: "agent",
  },
  {
    id: "ssh-2",
    name: "Production API",
    host: "10.0.4.21",
    port: 2222,
    username: "deploy",
    authMethod: "privateKey",
    privateKeyPath: "~/.ssh/id_ed25519",
    jumpHostId: "ssh-1",
    localForwards: [
      { id: "lfwd-1", localPort: 5432, remoteHost: "db.internal", remotePort: 5432, enabled: true },
    ],
  },
  {
    id: "ssh-3",
    name: "Staging",
    host: "staging.example.com",
    port: 22,
    username: "deploy",
    authMethod: "password",
  },
]

// The SSH hosts panel with a bastion, a host behind it with a forward, and a
// password host whose secret was never saved (its line says so).
export const SshHosts: Story = {
  parameters: {
    nextjs: { appDirectory: true, navigation: { query: { terminalPanel: "ssh" } } },
  },
  beforeEach: () => {
    resetStores(useSettingsStore, useProjectStore)
    seedStore(useSettingsStore, {
      settings: makeAgentAppSettings({ terminal: { sshHosts: SSH_HOSTS } }),
    })
  },
}

// A deep link from the dock or the device console, opening one host's form.
export const SshHostDeepLink: Story = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { query: { terminalPanel: "ssh", sshHost: "ssh-2" } },
    },
  },
  beforeEach: SshHosts.beforeEach,
}

export const DurableHostPanel: Story = {
  parameters: {
    nextjs: { appDirectory: true, navigation: { query: { terminalPanel: "host" } } },
  },
}
