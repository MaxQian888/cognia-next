import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SingleExportDialog } from "./single-export-dialog"
import { Button } from "@/components/ui/button"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useCustomThemeStore } from "@/stores/theme"
import type { ChatSession } from "@/lib/claude/types"

const session = {
  id: "ses_1",
  title: "Onboarding walkthrough",
  kind: "direct",
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now(),
} as unknown as ChatSession

// Single-session exporter (Markdown / JSON / Text / HTML / Animated). HTML +
// Animated expose the theme + custom-theme editor. Controlled `open` so the
// dialog body renders without interaction.
const meta = {
  title: "Data/SingleExportDialog",
  component: SingleExportDialog,
  args: { session, open: true, onOpenChange: fn() },
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useCustomThemeStore)
  },
} satisfies Meta<typeof SingleExportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Markdown: Story = {}

export const HtmlWithThemes: Story = { args: { defaultFormat: "html" } }

// Closed dialog driven by its own trigger button.
export const ViaTrigger: Story = {
  args: {
    open: undefined,
    onOpenChange: undefined,
    trigger: <Button variant="outline">Export chat</Button>,
  },
}
