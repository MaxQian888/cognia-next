import type { Meta, StoryObj } from "@storybook/nextjs"

import { HeaderAccountSwitcher } from "./header-account-switcher"
import type { ChatSession } from "@/lib/claude/types"

// Chat-header account badge + switcher (ADR-0028). Hidden when the active
// provider has ≤1 account. `testAccounts` force-passes a list and skips the IPC
// fetch, so the stories render deterministically.
const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "demo-session",
    title: "Demo",
    characterId: "claude",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    accountId: "acc-work",
    ...over,
  }) as ChatSession

const meta = {
  title: "Chat/HeaderAccountSwitcher",
  component: HeaderAccountSwitcher,
  parameters: { layout: "centered" },
  args: {
    session: session(),
    testAccounts: [
      { id: "acc-work", label: "Work" },
      { id: "acc-personal", label: "Personal" },
    ],
  },
} satisfies Meta<typeof HeaderAccountSwitcher>

export default meta
type Story = StoryObj<typeof meta>

/** Two accounts — the active one is "Work". Open the menu to switch. */
export const TwoAccounts: Story = {}

/** Three accounts, none explicitly active on the session. */
export const ThreeAccounts: Story = {
  args: {
    session: session({ accountId: undefined }),
    testAccounts: [
      { id: "acc-work", label: "Work" },
      { id: "acc-personal", label: "Personal" },
      { id: "acc-client", label: "Client" },
    ],
  },
}

/** A single account → the switcher renders nothing. */
export const SingleAccountHidden: Story = {
  args: { testAccounts: [{ id: "acc-work", label: "Work" }] },
}
