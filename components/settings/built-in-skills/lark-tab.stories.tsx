import type { Meta, StoryObj } from "@storybook/nextjs"

import { LarkTab } from "./lark-tab"

// Lark built-in skill family tab (ADR-0026). On mount it pulls the shared
// built-in skill registry and lists the Lark-platform skills grouped by family
// with per-skill mutation-tier badges (read / write / destructive). Renders an
// empty hint until the registry resolves. No props.
const meta = {
  title: "Settings/BuiltInSkills/LarkTab",
  component: LarkTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof LarkTab>

export default meta
type Story = StoryObj<typeof meta>

// Registry-driven: families render as collapsibles with mutation badges.
export const Default: Story = {}
