import type { Meta, StoryObj } from "@storybook/nextjs"

import { BehaviorCard } from "./behavior-card"

// Loads the automation settings blob through `desktop.settingsGet()`. In the
// Storybook browser that IPC call rejects (no Rust backend), so `settings`
// stays null and the card renders its title + description header (the
// pre-load state) — the model-behavior knobs appear once a backend resolves
// the blob under `pnpm tauri dev`.
const meta = {
  title: "Settings/Automation/BehaviorCard",
  component: BehaviorCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BehaviorCard>

export default meta
type Story = StoryObj<typeof meta>

// Web/no-backend branch — header only (settings unresolved).
export const Default: Story = {}
