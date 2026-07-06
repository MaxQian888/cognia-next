import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { Button } from "@/components/ui/button"
import { AccountList } from "./account-list"

// `AccountList` reads `useAccounts(provider)`, backed by the Tauri keyring. In
// the Storybook (non-Tauri) browser the hook resolves to an empty account list,
// so the card renders its title, the "Add account" button (wired to `onAdd`),
// and the empty-state hint. These stories exercise the props surface — provider
// variants and the optional secondary action slot.
const meta = {
  title: "Settings/Subscription/AccountList",
  component: AccountList,
  args: {
    provider: "anthropic",
    onAdd: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AccountList>

export default meta
type Story = StoryObj<typeof meta>

export const Anthropic: Story = {}

export const Codex: Story = {
  args: { provider: "codex" },
}

// OpenCode surfaces a secondary "Adopt discovered" style ghost action next to
// the primary Add button.
export const WithSecondaryAction: Story = {
  args: {
    provider: "opencode",
    secondaryAction: (
      <Button size="sm" variant="ghost" onClick={fn()}>
        Adopt discovered
      </Button>
    ),
  },
}
