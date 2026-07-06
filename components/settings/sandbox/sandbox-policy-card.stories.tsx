import type { Meta, StoryObj } from "@storybook/nextjs"

import { SandboxPolicyCard } from "./sandbox-policy-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"
import type { SandboxResourcePolicy } from "@/lib/claude/types"

// Store-reading: edits `settings.sandboxPolicy` (CPU / memory / network ceiling
// + writable roots). The network "allowlist" mode reveals the hosts textarea.
// Reset the settings store between stories.
function seed(sandboxPolicy: SandboxResourcePolicy) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings({ sandboxPolicy }) })
  }
}

const meta = {
  title: "Settings/Sandbox/SandboxPolicyCard",
  component: SandboxPolicyCard,
  parameters: { layout: "padded" },
  beforeEach: seed({}),
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SandboxPolicyCard>

export default meta
type Story = StoryObj<typeof meta>

// Empty policy — unlimited CPU/memory, network "on" (no allowlist textarea).
export const Default: Story = {}

// A constrained ceiling with an explicit network allowlist + writable roots.
export const Configured: Story = {
  beforeEach: seed({
    maxCpuSeconds: 30,
    maxMemoryMb: 512,
    network: "allowlist",
    networkAllowlist: ["api.github.com", "registry.npmjs.org"],
    writableRoots: ["/workspace", "/tmp/cognia"],
  }),
}
