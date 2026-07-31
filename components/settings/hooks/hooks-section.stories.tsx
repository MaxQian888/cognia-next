import type { Meta, StoryObj } from "@storybook/nextjs"

import { HooksSection } from "./hooks-section"

// Settings panel for the `hooks` block of `~/.claude/settings.json`. Reads the
// scoped Claude settings via the Tauri-backed `readClaude*Settings` helpers;
// in the browser those resolve to empty docs, so the section renders the
// event-tab grid with no configured groups. The project / local scope tabs
// stay disabled unless a `cwd` is supplied.
const meta = {
  title: "Settings/Hooks/HooksSection",
  component: HooksSection,
  parameters: { layout: "padded" },
} satisfies Meta<typeof HooksSection>

export default meta
type Story = StoryObj<typeof meta>

// User scope, no cwd → project/local tabs disabled, empty PreToolUse event.
export const Default: Story = {}

// With a cwd the project + local scope tabs become selectable.
export const WithProjectCwd: Story = {
  args: { cwd: "/home/max/projects/demo" },
}
