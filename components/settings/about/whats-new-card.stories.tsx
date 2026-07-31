import type { Meta, StoryObj } from "@storybook/nextjs"

import { WhatsNewCard } from "./whats-new-card"

// Pure, propless card: an accordion over the curated offline release notes in
// `lib/constants/release-notes.ts`. The latest release is expanded by default;
// highlight text is i18n-driven. The footer "view all" link fires `openExternal`
// (no-op outside Tauri).
const meta = {
  title: "Settings/About/WhatsNewCard",
  component: WhatsNewCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WhatsNewCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
