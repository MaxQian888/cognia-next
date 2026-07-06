import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderModelSwitcher } from "./provider-model-switcher"
import { seedDb } from "@/lib/storybook/seed-db"

// The badge label is derived purely from the `providerOverride` / `modelOverride`
// props; the dropdown options come from the `settings` singleton (Dexie). With
// no settings seeded the menu shows "no providers configured" — the WithOptions
// story seeds a provider map so the option list renders.
const meta = {
  title: "Inbox/ProviderModelSwitcher",
  component: ProviderModelSwitcher,
  args: { conversationKey: "slack:adapter-1:C1", sessionId: "ses_1", onChange: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProviderModelSwitcher>

export default meta
type Story = StoryObj<typeof meta>

export const DefaultNoOverride: Story = {}

export const ProviderOverride: Story = {
  args: { providerOverride: "codex" },
}

export const ProviderAndModel: Story = {
  args: { providerOverride: "codex", modelOverride: "gpt-5" },
}

export const WithOptions: Story = {
  args: { providerOverride: "anthropic", modelOverride: "claude-opus" },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.settings.put({
        id: "singleton",
        providerSettings: {
          anthropic: { enabled: true, models: ["claude-opus", "claude-sonnet"] },
          codex: { enabled: true, models: ["gpt-5"] },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    })
  },
}
