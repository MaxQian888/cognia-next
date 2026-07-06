import type { Meta, StoryObj } from "@storybook/nextjs"

import { WikiRebuildCard } from "./wiki-rebuild-card"

// Card showing the local wiki manifest (Dexie-backed) + a Tauri-gated
// "rebuild" action. In the browser the manifest is absent and the rebuild
// button is disabled (`isTauri()`). No props.
const meta = {
  title: "Settings/ExternalBridge/WikiRebuildCard",
  component: WikiRebuildCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WikiRebuildCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
