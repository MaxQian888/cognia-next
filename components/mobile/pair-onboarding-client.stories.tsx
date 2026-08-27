import type { Meta, StoryObj } from "@storybook/nextjs"

import { PairOnboardingClient } from "./pair-onboarding-client"

/**
 * The whole `/pair` route, as a browser sees it.
 *
 * Storybook reports `usePlatform() === "web"` (no Tauri or Capacitor globals),
 * which is exactly the surface this story exists to check: the two-pane window
 * `PairShell` paints, with the live loopback probe running in the panel beside
 * the form. `hydrateCompanionConfig` finds no pairing in the Storybook profile,
 * so the flow settles on the pair step, and no Host answers on the Storybook
 * host — which makes this the `absent` state end to end.
 *
 * The individual scene states (including the origin-refused case, which needs a
 * Host that is running *and* refusing) are in `pair/pair-shell.stories.tsx`.
 */
const meta = {
  title: "Mobile/Pair/PairOnboardingClient",
  component: PairOnboardingClient,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PairOnboardingClient>

export default meta
type Story = StoryObj<typeof meta>

/** Desktop browser. */
export const WebBrowser: Story = {}
