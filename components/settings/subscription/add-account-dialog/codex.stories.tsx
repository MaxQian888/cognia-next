import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CodexAddAccountDialog } from "./codex"

// Codex add-account dialog — two modes (reuse a discovered codex-cli credential
// vs device-code OAuth). Props-only: `open`, `onOpenChange`, `onAdded`, and an
// optional `initialMode`. Discovery runs through `useCodexDiscovery`; in the
// Storybook (non-Tauri) browser nothing is discovered, so the "reuse" mode is
// disabled and the dialog defaults to OAuth (which shows the "start OAuth"
// prompt). Forcing `initialMode="reuse"` documents the (disabled) reuse panel.
const meta = {
  title: "Settings/Subscription/AddAccountDialog/CodexAddAccountDialog",
  component: CodexAddAccountDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    onAdded: fn(),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof CodexAddAccountDialog>

export default meta
type Story = StoryObj<typeof meta>

// No discovered credential in the browser → defaults to the OAuth panel.
export const OauthMode: Story = {
  args: { initialMode: "oauth" },
}

// Reuse mode with nothing discovered shows the "none found" / rescan panel.
export const ReuseMode: Story = {
  args: { initialMode: "reuse" },
}

export const Closed: Story = {
  args: { open: false },
}
