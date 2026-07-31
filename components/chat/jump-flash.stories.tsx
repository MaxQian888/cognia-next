import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"

import { JumpFlash } from "./jump-flash"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

/** `useFlowMotion` reads the settings store, so stories seed it rather than a parameter. */
const seedMotion = (motion: AppSettings["motion"]) => async () => {
  useSettingsStore.setState({ settings: { motion } as AppSettings, save: async () => {} })
}

/**
 * The landing mark. Before this, arriving somewhere was unverifiable: in a
 * long, repetitive conversation "did that go where I meant?" is a real
 * question, and scrolling silently is indistinguishable from scrolling to the
 * wrong place.
 *
 * It paints `opacity`/`transform` only, so marking a row inside a tool-dense
 * reply costs no layout.
 */
const meta = {
  title: "Chat/JumpFlash",
  component: JumpFlash,
  parameters: { layout: "padded" },
  args: { nonce: 1, holdMs: 1200 },
  beforeEach: seedMotion({ reduce: false, speed: 1 }),
} satisfies Meta<typeof JumpFlash>

export default meta
type Story = StoryObj<typeof meta>

function MessageRow({ children }: { children?: React.ReactNode }) {
  return (
    <div className="relative w-[520px] rounded-md p-4">
      {children}
      <div className="space-y-2">
        <p className="text-sm font-medium">You</p>
        <p className="text-sm text-muted-foreground">
          Can you walk me through why the deploy step is retrying three times?
        </p>
      </div>
    </div>
  )
}

/** The mark over a message row, at rest. */
export const OverAMessage: Story = {
  render: (args) => (
    <MessageRow>
      <JumpFlash {...args} />
    </MessageRow>
  ),
}

/**
 * Re-marking the SAME message. A bumped nonce restarts the animation, which
 * matters because repeating the jump is exactly what a user does when they are
 * not sure it worked — without this, the second attempt would look like a
 * no-op.
 */
export const ReplayOnSameMessage: Story = {
  render: (args) => {
    const [nonce, setNonce] = React.useState(args.nonce)
    return (
      <div className="space-y-3">
        <MessageRow>
          <JumpFlash {...args} nonce={nonce} />
        </MessageRow>
        <Button size="sm" variant="outline" onClick={() => setNonce((n) => n + 1)}>
          Jump here again (nonce {nonce})
        </Button>
      </div>
    )
  },
}

/** Held flat rather than animated away — the answer to "where did I land?" is still owed. */
export const ReducedMotion: Story = {
  beforeEach: seedMotion({ reduce: true, speed: 1 }),
  render: (args) => (
    <MessageRow>
      <JumpFlash {...args} />
    </MessageRow>
  ),
}

/** A longer hold, as `motion.speed` produces on the slowest setting. */
export const SlowHold: Story = {
  args: { holdMs: 3000 },
  render: (args) => (
    <MessageRow>
      <JumpFlash {...args} />
    </MessageRow>
  ),
}
