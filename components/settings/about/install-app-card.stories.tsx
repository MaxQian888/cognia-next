import type { Meta, StoryObj } from "@storybook/nextjs"

import { InstallAppCard } from "./install-app-card"

// Platform-gated card: renders only on the web shell (detectPlatform() →
// "web" inside Storybook) and otherwise returns null. Its four states come
// from `lib/pwa/install-state`; in a plain browser story that resolves to
// `unavailable` until a real `beforeinstallprompt` fires.
const meta = {
  title: "Settings/About/InstallAppCard",
  component: InstallAppCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof InstallAppCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
