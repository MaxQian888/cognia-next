import type { Meta, StoryObj } from "@storybook/nextjs"

import { ProviderTabOpencode } from "./provider-tab-opencode"

// `ProviderTabOpencode` is propless. It composes the (keyring-backed,
// empty-in-browser) account list + preset picker with an inline read-only
// discovery card driven by `useOpencodeDiscovery`. In the Storybook (non-Tauri)
// browser discovery yields no entries, so the discovery card renders its empty
// hint plus the whitelist footnote and the rescan button.
const meta = {
  title: "Settings/Subscription/ProviderTabOpencode",
  component: ProviderTabOpencode,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProviderTabOpencode>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
