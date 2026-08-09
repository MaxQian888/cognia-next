import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PairStep } from "./pair-step"
import { encodePairPayload } from "@/lib/qr/pair-payload"

// Canonical device-key pair form. The payload contains a one-shot invitation;
// no long-lived bearer credential is rendered or persisted.
// `scanBarcode`/`saveCompanionConfig` only fire on user actions, so the form
// renders fully in the Storybook browser.
const meta = {
  title: "Mobile/Pair/PairStep",
  component: PairStep,
  parameters: { layout: "fullscreen" },
  args: { onPaired: fn(), onBack: fn() },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PairStep>

export default meta
type Story = StoryObj<typeof meta>

/** Fresh form. */
export const Default: Story = {}

/** Full one-shot invitation payload pasted by the user. */
export const PrefilledInvitation: Story = {
  args: {
    prefilledPairPayload: encodePairPayload({
      baseUrl: "https://192.168.1.42:7890",
      mode: "owner-invitation",
      invitation: "owner-invitation",
      hostId: "host-story",
      tenantId: "local_acct_a",
      expiresAt: Date.now() + 10 * 60_000,
      serverVersion: "1.0.0",
      fingerprint: "ab".repeat(32),
    }),
  },
}
