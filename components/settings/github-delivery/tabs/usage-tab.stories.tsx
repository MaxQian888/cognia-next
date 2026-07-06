import type { Meta, StoryObj } from "@storybook/nextjs"

import { UsageTab } from "./usage-tab"

// GitHub Delivery → Usage tab: per-repo delivery counts / rate-limit usage
// from the Dexie store. Empty in the browser (fresh IndexedDB). No props.
const meta = {
  title: "Settings/GithubDelivery/Tabs/UsageTab",
  component: UsageTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof UsageTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
