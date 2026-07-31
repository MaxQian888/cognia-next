import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import type { UIMessage } from "ai"

import { BranchNavigator } from "./branch-navigator"
import { useChatStore } from "@/stores/chat/chat-store"

const branchMsg = (id: string, branchGroupId: string, branchIndex: number): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: id }],
    metadata: { branchGroupId, branchIndex },
  }) as unknown as UIMessage

const a = branchMsg("a", "g1", 0)
const b = branchMsg("b", "g1", 1)
const c = branchMsg("c", "g1", 2)

// Seed the chat store the same way branch-navigator.test.tsx does, so the
// navigator finds its sibling branches.
const seedBranches = (siblings: UIMessage[], active: string) => async () => {
  const store = useChatStore.getState()
  store.clear()
  store.replaceMessages(siblings)
  store.setActiveBranch("g1", active)
}

const meta = {
  title: "Chat/BranchNavigator",
  component: BranchNavigator,
} satisfies Meta<typeof BranchNavigator>

export default meta
type Story = StoryObj<typeof meta>

export const SecondOfThree: Story = {
  args: { message: b },
  beforeEach: seedBranches([a, b, c], "b"),
}

export const FirstOfTwo: Story = {
  args: { message: a },
  beforeEach: seedBranches([a, b], "a"),
}
