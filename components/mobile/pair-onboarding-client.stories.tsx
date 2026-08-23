import type { Meta, StoryObj } from "@storybook/nextjs"

import { PairOnboardingClient } from "./pair-onboarding-client"

/**
 * The whole `/pair` route, as a browser sees it.
 *
 * Storybook reports `usePlatform() === "web"` (no Tauri or Capacitor globals),
 * which is exactly the surface this story exists to check: the two-column web
 * layout that replaced the phone-width column the route used to render at every
 * viewport. `hydrateCompanionConfig` finds no pairing in the Storybook profile,
 * so the flow settles on the pair step.
 */
const meta = {
  title: "Mobile/Pair/PairOnboardingClient",
  component: PairOnboardingClient,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PairOnboardingClient>

export default meta
type Story = StoryObj<typeof meta>

/** Desktop browser — the reported "looks bad and scrolls" surface. */
export const WebBrowser: Story = {}
