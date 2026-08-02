import type { Meta, StoryObj } from "@storybook/nextjs"

import { CustomModeSettings } from "./custom-mode-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"

// `CustomModeSettings` is the master/detail surface over `useCustomModeStore`:
// a filterable rail (search / category / sort / bulk-select) beside a pane
// showing the selected mode's prompt, tools, tags and overrides. Reset between
// stories so seeded modes don't leak; `Populated` seeds two modes so the rail
// and the pane both have something to show.
const now = new Date("2026-06-01T12:00:00Z")

const sampleModes = {
  "mode-research": {
    id: "mode-research",
    name: "Deep Research",
    description: "Multi-source investigation with citation tracking.",
    icon: "Search",
    category: "research",
    systemPrompt: "You are a meticulous researcher.",
    tools: ["web_search", "read"],
    tags: ["research", "analysis"],
    usageCount: 12,
    createdAt: now,
    updatedAt: now,
  },
  "mode-refactor": {
    id: "mode-refactor",
    name: "Surgical Refactor",
    description: "Behaviour-preserving cleanups, minimal diffs.",
    icon: "Wand2",
    category: "technical",
    systemPrompt: "You make the smallest change that solves the task.",
    tools: ["edit", "bash"],
    tags: ["coding"],
    usageCount: 3,
    createdAt: now,
    updatedAt: now,
  },
}

const meta = {
  title: "Settings/Agent/CustomModeSettings",
  component: CustomModeSettings,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useCustomModeStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[720px] max-w-5xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CustomModeSettings>

export default meta
type Story = StoryObj<typeof meta>

// No custom modes yet — the create-first-mode empty state.
export const Empty: Story = {}

// A couple of user-defined modes; the first is auto-selected in the pane.
export const Populated: Story = {
  beforeEach: () => {
    resetStore(useCustomModeStore)
    seedStore(useCustomModeStore, { customModes: sampleModes } as never)
  },
}
