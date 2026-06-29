import type { Meta, StoryObj } from "@storybook/nextjs"

import { AccountGate } from "./account-gate"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useAccountStore } from "@/stores/account/account-store"

function Protected() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Protected app content
    </div>
  )
}

// At-rest gate for the desktop app. Local password accounts are Tauri-only, so
// in Storybook (web) the gate passes through to its children once loaded; before
// the account store loads it shows the loading shell.
const meta = {
  title: "Account/AccountGate",
  component: AccountGate,
  args: { children: <Protected /> },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[400px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AccountGate>

export default meta
type Story = StoryObj<typeof meta>

// Store not yet loaded → the centered loading shell.
export const Loading: Story = {
  beforeEach: () => {
    resetStore(useAccountStore)
    seedStore(useAccountStore, { loaded: false, loading: true })
  },
}

// Loaded on web (no Tauri) → passes through to the protected children.
export const WebPassThrough: Story = {
  beforeEach: () => {
    resetStore(useAccountStore)
    seedStore(useAccountStore, { loaded: true })
  },
}
