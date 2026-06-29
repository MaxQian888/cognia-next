import type { Meta, StoryObj } from "@storybook/nextjs"

import { ExternalMemoryTab } from "./external-memory-tab"

// `/memory` → external-agent tab. Discovers and guardedly edits Claude Code /
// Codex on-disk memory files. Desktop-only: on web (Storybook) `useExternalMemory`
// reports unsupported, so the panel renders its desktop-only explainer.
const meta = {
  title: "Memory/ExternalMemoryTab",
  component: ExternalMemoryTab,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExternalMemoryTab>

export default meta
type Story = StoryObj<typeof meta>

export const DesktopOnlyFallback: Story = {}
