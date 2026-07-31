import type { Meta, StoryObj } from "@storybook/nextjs"

import { ResourcesCard } from "./resources-card"

// Pure, propless card: a fixed list of outbound resource links (docs, repo,
// issues, releases, community). Each button fires `openExternal`, which is a
// no-op outside Tauri, so the web/Storybook path renders the full list safely.
const meta = {
  title: "Settings/About/ResourcesCard",
  component: ResourcesCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ResourcesCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
