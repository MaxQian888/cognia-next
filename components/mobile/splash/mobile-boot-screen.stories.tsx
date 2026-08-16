import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileBootScreen, __resetMobileBootScreenForTesting } from "./mobile-boot-screen"
import {
  __resetBootProgressForTesting,
  beginBootMilestone,
  endBootMilestone,
} from "@/lib/boot/boot-progress"
import {
  __resetMobileBootForTesting,
  beginMobileBootStage,
  endMobileBootStage,
  markMobileBootIntroPlayed,
  markMobileBootSettled,
  skipMobileBootStagesAfter,
} from "@/lib/boot/mobile-boot-stages"

/** The gates are behind the overlay: seed them as finished with realistic timings. */
function seedGates() {
  const now = Date.now()
  beginBootMilestone("accounts", now - 900)
  endBootMilestone("accounts", now - 470)
  beginBootMilestone("preferences", now - 470)
  endBootMilestone("preferences", now - 350)
}

const meta = {
  title: "Mobile/MobileBootScreen",
  component: MobileBootScreen,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile2" },
  },
  beforeEach: () => {
    __resetBootProgressForTesting()
    __resetMobileBootForTesting()
    __resetMobileBootScreenForTesting()
  },
} satisfies Meta<typeof MobileBootScreen>

export default meta
type Story = StoryObj<typeof meta>

/** Splash overlay, first frame after the native hand-over: plays the reveal. */
export const OverlayReveal: Story = {
  args: { milestone: null },
  decorators: [
    (Story) => {
      seedGates()
      return <Story />
    },
  ],
}

/** Mid-boot: bridge + pairing done, reaching the desktop. */
export const OverlayReachingHost: Story = {
  args: { milestone: null },
  decorators: [
    (Story) => {
      seedGates()
      const now = Date.now()
      beginMobileBootStage("bridge", now - 350)
      endMobileBootStage("bridge", { detail: "registered" }, now - 290)
      beginMobileBootStage("companion", now - 290)
      endMobileBootStage("companion", { detail: "paired" }, now - 60)
      beginMobileBootStage("host", now - 60)
      markMobileBootIntroPlayed()
      return <Story />
    },
  ],
}

/** Settled and syncing: the arc has closed into a solid ring with the check badge. */
export const OverlaySettledSyncing: Story = {
  args: { milestone: null },
  decorators: [
    (Story) => {
      seedGates()
      const now = Date.now()
      beginMobileBootStage("bridge", now - 350)
      endMobileBootStage("bridge", { detail: "registered" }, now - 290)
      beginMobileBootStage("companion", now - 290)
      endMobileBootStage("companion", { detail: "paired" }, now - 60)
      beginMobileBootStage("host", now - 60)
      endMobileBootStage("host", { detail: "linked" }, now - 10)
      markMobileBootSettled()
      beginMobileBootStage("sync", now - 10)
      markMobileBootIntroPlayed()
      return <Story />
    },
  ],
}

/** Standalone phone: no host, later stages not needed. */
export const OverlayStandalone: Story = {
  args: { milestone: null },
  decorators: [
    (Story) => {
      seedGates()
      const now = Date.now()
      beginMobileBootStage("bridge", now - 350)
      endMobileBootStage("bridge", { detail: "registered" }, now - 290)
      beginMobileBootStage("companion", now - 290)
      endMobileBootStage("companion", { detail: "standalone" }, now - 100)
      skipMobileBootStagesAfter("companion", now - 100)
      markMobileBootSettled()
      markMobileBootIntroPlayed()
      return <Story />
    },
  ],
}

/** Paired but the desktop is unreachable: host failed, sync not needed. */
export const OverlayHostOffline: Story = {
  args: { milestone: null },
  decorators: [
    (Story) => {
      seedGates()
      const now = Date.now()
      beginMobileBootStage("bridge", now - 350)
      endMobileBootStage("bridge", { detail: "registered" }, now - 290)
      beginMobileBootStage("companion", now - 290)
      endMobileBootStage("companion", { detail: "paired" }, now - 60)
      beginMobileBootStage("host", now - 60)
      endMobileBootStage("host", { status: "failed", detail: "offline" }, now - 5)
      skipMobileBootStagesAfter("host", now - 5)
      markMobileBootSettled()
      markMobileBootIntroPlayed()
      return <Story />
    },
  ],
}

/** Cold-boot gate: the account registry is being read (usually under the native splash). */
export const GateAccounts: Story = {
  args: { milestone: "accounts", allowReload: true },
}

/** A prolonged gate wait: reassurance line, then the reload offer. */
export const GateEscalated: Story = {
  args: { milestone: "preferences", allowReload: true },
  decorators: [
    (Story) => {
      // Anchor the sequence 20s in the past (and keep it continuous — a gap
      // longer than BOOT_SEQUENCE_GAP_MS would start a fresh one) so the
      // phase ladder is already at "escalated" on first tick.
      const now = Date.now()
      beginBootMilestone("accounts", now - 20_000)
      endBootMilestone("accounts", now - 100)
      markMobileBootIntroPlayed()
      return <Story />
    },
  ],
}

/** A route transition inside the running app: compact, in flow, themed. */
export const RouteTransition: Story = {
  args: { milestone: "workspace" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => {
      markMobileBootIntroPlayed()
      return <Story />
    },
  ],
}
