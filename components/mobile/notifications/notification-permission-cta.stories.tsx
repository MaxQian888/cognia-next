import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { NotificationPermissionCta } from "./notification-permission-cta"

// Local-notification permission CTA. The default `checker` returns "unsupported"
// in the Storybook browser (component renders null), so each story injects a
// `checker` seam to force a concrete phase. `requester`/`settingsOpener` are
// no-op seams.
const meta = {
  title: "Mobile/Notifications/NotificationPermissionCta",
  component: NotificationPermissionCta,
  parameters: { layout: "fullscreen" },
  args: {
    requester: fn(async () => ({ kind: "ok", value: "granted" }) as const),
    settingsOpener: fn(async () => ({ kind: "ok" }) as const),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationPermissionCta>

export default meta
type Story = StoryObj<typeof meta>

/** Undecided — shows the "Enable" CTA. */
export const Prompt: Story = {
  args: { checker: fn(async () => ({ kind: "ok", value: "prompt" }) as const) },
}

/** Previously denied — shows the "Open Settings" recovery CTA. */
export const Denied: Story = {
  args: { checker: fn(async () => ({ kind: "ok", value: "denied" }) as const) },
}
