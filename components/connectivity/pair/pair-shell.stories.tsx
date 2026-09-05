import type { Meta, StoryObj } from "@storybook/nextjs"

import { HeadlessInvitationHelp } from "./headless-invitation-help"
import { HostProbeStatus } from "./host-probe-status"
import { PairShell } from "./pair-shell"

/**
 * The `/pair` window at each state its scene can draw.
 *
 * The route itself is gated behind an account unlock in a dev server, so these
 * are the practical way to see the surface — including the one thing the route
 * story cannot show on demand: what a refused browser origin looks like.
 */
const meta = {
  title: "Mobile/Pair/PairShell",
  component: PairShell,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PairShell>

export default meta
type Story = StoryObj<typeof meta>

const body = (
  <div className="flex flex-col gap-3 rounded-xl border p-4 text-sm text-muted-foreground">
    the step body goes here
  </div>
)

/** A browser with nothing pasted yet, still probing this machine. */
export const WebSearching: Story = {
  args: {
    client: "web",
    sceneState: "searching",
    step: "pair",
    steps: ["pair", "paired"],
    bodyKey: "pair",
    children: body,
    status: <HostProbeStatus state="searching" />,
    aside: <HeadlessInvitationHelp />,
  },
}

/** A Host answered and refused this origin — the case with no UI before. */
export const WebOriginBlocked: Story = {
  args: {
    ...WebSearching.args,
    sceneState: "blocked",
    status: (
      <HostProbeStatus
        state="blocked"
        baseUrl="http://127.0.0.1:27891"
        origin="http://localhost:3000"
      />
    ),
  },
}

/** An invitation is decoded and waiting for the button. */
export const WebArmed: Story = {
  args: {
    ...WebSearching.args,
    sceneState: "armed",
    status: (
      <HostProbeStatus state="reachable" baseUrl="http://127.0.0.1:27891" serverVersion="0.1.0" />
    ),
  },
}

/** The attempt failed. */
export const WebFailed: Story = {
  args: { ...WebArmed.args, sceneState: "failed" },
}

/** A phone on the discover step — no command block, three steps. */
export const MobileDiscovering: Story = {
  args: {
    client: "mobile",
    sceneState: "searching",
    step: "discover",
    bodyKey: "discover",
    children: body,
  },
}

/** Settled. */
export const MobilePaired: Story = {
  args: {
    client: "mobile",
    sceneState: "paired",
    step: "paired",
    bodyKey: "paired",
    children: body,
  },
}
