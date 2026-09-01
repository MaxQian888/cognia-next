import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { ExecutorChoiceList } from "./executor-choice"
import type { ChatExecutor } from "./use-chat-executor"

function executor(over: Partial<ChatExecutor> = {}): ChatExecutor {
  return {
    squadId: null,
    squadName: null,
    squads: [],
    select: async () => undefined,
    bindable: true,
    ...over,
  }
}

const SQUADS = [
  {
    id: "a",
    name: "Research Squad",
    status: "executing",
    memberCount: 4,
    live: true,
    waiting: false,
  },
  { id: "b", name: "Refactor Crew", status: "idle", memberCount: 2, live: false, waiting: false },
  {
    id: "c",
    name: "Release Readiness",
    status: "executing",
    memberCount: 6,
    live: true,
    waiting: true,
  },
]

const meta = {
  title: "Agent/Composition/ExecutorChoice",
  component: ExecutorChoiceList,
  args: { executor: executor({ squads: SQUADS }) },
  decorators: [
    (Story) => (
      <div className="w-80 rounded-md border bg-popover p-3 text-popover-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExecutorChoiceList>

export default meta
type Story = StoryObj<typeof meta>

/** The ordinary case: several Squads available, conversation on a single agent. */
export const SingleAgent: Story = {}

/** Bound — the active row is the one the conversation actually runs on. */
export const OnASquad: Story = {
  args: { executor: executor({ squads: SQUADS, squadId: "b", squadName: "Refactor Crew" }) },
}

/** Nothing to pick yet. Says why, instead of showing one unexplained row. */
export const NoSquadsYet: Story = {
  args: { executor: executor() },
}

/** Before the first message there is no conversation to bind — a different reason. */
export const BeforeFirstMessage: Story = {
  args: { executor: executor({ squads: SQUADS, bindable: false }) },
}

/** Mid-turn: the executor cannot change under a running send. */
export const WhileStreaming: Story = {
  args: {
    executor: executor({ squads: SQUADS, squadId: "a", squadName: "Research Squad" }),
    disabled: true,
  },
}
