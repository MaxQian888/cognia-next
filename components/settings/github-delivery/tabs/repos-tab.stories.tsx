import type { Meta, StoryObj } from "@storybook/nextjs"

import { ReposTab } from "./repos-tab"

// GitHub Delivery → Repos tab: tracked repositories from the Dexie store, with
// a desktop-gated "add repo" flow. In the browser the list renders empty and
// the add affordance is disabled (`isTauri()`). No props.
const meta = {
  title: "Settings/GithubDelivery/Tabs/ReposTab",
  component: ReposTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ReposTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty repo list (fresh in-browser IndexedDB).
export const Default: Story = {}
