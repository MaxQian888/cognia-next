import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PairedStep } from "./paired-step"

// Post-pairing "you're connected" screen: connection-health card, collapsible
// diagnostics, the notification-permission CTA (renders null off-Capacitor),
// and the sign-out card. `transport.call` / biometric guard only fire on taps,
// so the screen renders from its props in the Storybook browser.
const meta = {
  title: "Mobile/Pair/PairedStep",
  component: PairedStep,
  parameters: { layout: "fullscreen" },
  args: {
    baseUrl: "https://192.168.1.42:7890",
    deviceId: "device-7f3a91c2-0000-4000-8000-000000000000",
    serverVersion: "1.4.2",
    onContinue: fn(),
    onAfterSignOut: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PairedStep>

export default meta
type Story = StoryObj<typeof meta>

/** Healthy connection — the state immediately after a successful pair. */
export const Connected: Story = {}
