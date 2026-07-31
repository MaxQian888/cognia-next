import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { NotificationsQueueSheet } from "./notifications-queue-sheet"
import type { LocalNotificationSpec } from "@/lib/capacitor/local-notifications"

// Bottom sheet listing scheduled local notifications. Pure with seams: `lister`
// supplies the queue (the real wrapper returns "unsupported" off-Capacitor) and
// `canceller` is a no-op. Each story forces a phase via `lister`.
const BASE = new Date("2026-06-01T09:00:00.000Z").getTime()

const queue: LocalNotificationSpec[] = [
  {
    id: 91_001,
    title: "Daily backup reminder",
    body: "Keep your desktop online so cognia can back up your data.",
    schedule: { at: new Date(BASE + 86_400_000) },
  },
  {
    id: 91_002,
    title: "Scheduler nudge",
    body: "Overnight digest runs at 9am.",
    schedule: { at: new Date(BASE + 3_600_000) },
  },
]

const meta = {
  title: "Mobile/Notifications/NotificationsQueueSheet",
  component: NotificationsQueueSheet,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    canceller: fn(async () => ({ kind: "ok" }) as const),
  },
} satisfies Meta<typeof NotificationsQueueSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Two scheduled notifications, each with a per-row cancel. */
export const Loaded: Story = {
  args: { lister: fn(async () => ({ kind: "ok", value: queue }) as const) },
}

/** Platform supports notifications but nothing is queued. */
export const Empty: Story = {
  args: {
    lister: fn(async () => ({ kind: "ok" as const, value: [] as LocalNotificationSpec[] })),
  },
}

/** Web / Tauri — local notifications are not supported. */
export const Unsupported: Story = {
  args: { lister: fn(async () => ({ kind: "unsupported" }) as const) },
}

/** The plugin call failed. */
export const ErrorState: Story = {
  args: {
    lister: fn(async () => ({ kind: "error", message: "Plugin not available" }) as const),
  },
}
