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
} satisfies Meta<typeof PairStep>

export default meta
type Story = StoryObj<typeof meta>

/** Phone-width frame — the Capacitor shell's real viewport. */
const PHONE_DECORATOR = (Story: () => React.ReactElement) => (
  <div className="mx-auto h-[760px] w-[390px] overflow-y-auto p-4">
    <Story />
  </div>
)

/**
 * Browser-width frame, matching the `lg:max-w-4xl` the `/pair` route gives the
 * web flow. Story decorators nest *inside* meta decorators, so the two widths
 * have to be siblings here rather than one wrapping the other.
 */
const WEB_DECORATOR = (Story: () => React.ReactElement) => (
  <div className="mx-auto w-full max-w-4xl p-8">
    <Story />
  </div>
)

/** Fresh form. */
export const Default: Story = { decorators: [PHONE_DECORATOR] }

/**
 * The browser form at desktop width: two columns, so pasting an invitation
 * fills the empty half instead of pushing the page past the fold.
 */
export const WebDesktop: Story = {
  // The coordinator passes no `onBack` on web — there is no discovery step to
  // go back to — so the story must not either.
  args: { webMode: true, onBack: undefined },
  decorators: [WEB_DECORATOR],
}

/** The same form with a decoded invitation — the state that used to add scroll. */
export const WebDesktopWithInvitation: Story = {
  args: {
    webMode: true,
    onBack: undefined,
    prefilledPairPayload: encodePairPayload({
      baseUrl: "http://127.0.0.1:27891",
      mode: "owner-invitation",
      invitation: "owner-invitation",
      hostId: "host-story",
      tenantId: "local_acct_a",
      expiresAt: Date.now() + 10 * 60_000,
      serverVersion: "1.0.0",
      fingerprint: "cd".repeat(32),
    }),
  },
  decorators: [WEB_DECORATOR],
}

/** Full one-shot invitation payload pasted by the user. */
export const PrefilledInvitation: Story = {
  decorators: [PHONE_DECORATOR],
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
