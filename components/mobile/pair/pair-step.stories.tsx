import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PairStep } from "./pair-step"

// Manual-entry pair form (QR scan + URL + JWT/code tabs). Pure: the prefill
// props seed the form once on mount and `lockBaseUrl` makes the URL read-only.
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

/** Fresh form — defaults to the 6-digit code tab. */
export const Default: Story = {}

/** Arrived from Discover: base URL pre-filled + locked, JWT tab active. */
export const PrefilledServer: Story = {
  args: {
    prefilledBaseUrl: "https://192.168.1.42:7890",
    prefilledPairJwt: "eyJhbGciOiJIUzI1Ni;example.pair.jwt",
    lockBaseUrl: true,
  },
}

/** Pre-filled with a pinned TLS fingerprint — shows the security banner. */
export const WithFingerprintPin: Story = {
  args: {
    prefilledBaseUrl: "https://192.168.1.42:7890",
    prefilledPairJwt: "eyJhbGciOiJIUzI1Ni;example.pair.jwt",
    prefilledFingerprint:
      "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
    lockBaseUrl: true,
  },
}
