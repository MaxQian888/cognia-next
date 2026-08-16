import type { Meta, StoryObj } from "@storybook/nextjs"

import { BootScreen, __resetBootScreenForTesting } from "./boot-screen"
import { __resetBootCapabilitiesForTesting, markBootCapabilityReady } from "@/lib/boot/capabilities"
import {
  __resetBootProgressForTesting,
  beginBootMilestone,
  endBootMilestone,
  markBootIntroPlayed,
  type BootMilestone,
} from "@/lib/boot/boot-progress"

/**
 * Seed the shared boot timeline as if the milestones before `upTo` had just
 * finished with the given durations, so a story for a later milestone shows
 * the ticked rows, their timings and the assembling preview.
 */
function seedTimeline(upTo: BootMilestone, durations: Partial<Record<BootMilestone, number>>) {
  const order: BootMilestone[] = ["accounts", "preferences", "interface", "workspace"]
  let cursor = Date.now() - 50
  for (const milestone of order) {
    if (milestone === upTo) break
    const ms = durations[milestone]
    if (ms === undefined) continue
    beginBootMilestone(milestone, cursor - ms)
    endBootMilestone(milestone, cursor)
    cursor += 1
  }
}

const meta = {
  title: "Boot/BootScreen",
  component: BootScreen,
  parameters: { layout: "fullscreen" },
  args: { allowReload: true },
  beforeEach: () => {
    __resetBootProgressForTesting()
    __resetBootScreenForTesting()
    __resetBootCapabilitiesForTesting("eager")
  },
} satisfies Meta<typeof BootScreen>

export default meta
type Story = StoryObj<typeof meta>

/** Cold boot, first frame: the account registry is being read. Plays the intro. */
export const Accounts: Story = {
  args: { milestone: "accounts" },
}

/** Second owner: preferences hydrating, account step ticked with its timing. */
export const Preferences: Story = {
  args: { milestone: "preferences" },
  decorators: [
    (Story) => {
      seedTimeline("preferences", { accounts: 430 })
      markBootIntroPlayed()
      return <Story />
    },
  ],
}

/** Shell hydration gap; the preferences step was passed over without a loader. */
export const Interface: Story = {
  args: { milestone: "interface" },
  decorators: [
    (Story) => {
      seedTimeline("interface", { accounts: 430 })
      markBootIntroPlayed()
      return <Story />
    },
  ],
}

/** Last step of a cold boot, with the runtime capabilities partly up. */
export const WorkspaceOnBoot: Story = {
  args: { milestone: "workspace" },
  decorators: [
    (Story) => {
      seedTimeline("workspace", { accounts: 430, preferences: 120, interface: 16 })
      markBootIntroPlayed()
      markBootCapabilityReady("core-chat")
      markBootCapabilityReady("plugin-runtime")
      return <Story />
    },
  ],
}

/** A later route transition: only the workspace step, no intro. */
export const RouteTransition: Story = {
  args: { milestone: "workspace" },
  decorators: [
    (Story) => {
      markBootIntroPlayed()
      return <Story />
    },
  ],
}

/** The wait has gone on: reassurance line, then the reload offer. */
export const Escalated: Story = {
  args: { milestone: "accounts" },
  decorators: [
    (Story) => {
      // Anchor the sequence 20s in the past so the phase ladder is already at
      // "escalated" on first render.
      beginBootMilestone("accounts", Date.now() - 20_000)
      return <Story />
    },
  ],
}
