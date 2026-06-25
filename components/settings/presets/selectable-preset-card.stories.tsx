import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { StarIcon } from "lucide-react"

import { SelectablePresetCard, type SelectablePresetBadge } from "./selectable-preset-card"
import { Button } from "@/components/ui/button"

const BADGES: SelectablePresetBadge[] = ["active", "inactive", "builtin", "default", "favorite"]

const meta = {
  title: "Settings/SelectablePresetCard",
  component: SelectablePresetCard,
  args: {
    title: "Claude Opus · long-context",
    subtitle: "anthropic / claude-opus-4-8",
    badge: "active",
    badgeLabel: "Active",
    onClick: fn(),
    className: "max-w-md",
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SelectablePresetCard>

export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {}

export const Selected: Story = { args: { selected: true } }

export const Disabled: Story = {
  args: { disabled: true, badge: "inactive", badgeLabel: "Inactive" },
}

export const WithLeadingAndActions: Story = {
  args: {
    badge: "favorite",
    badgeLabel: "Favorite",
    leading: <StarIcon className="size-4 text-amber-500" />,
    details: <span className="text-muted-foreground">temperature 0.7 · 4k max tokens</span>,
    actions: (
      <Button size="sm" variant="ghost">
        Edit
      </Button>
    ),
  },
}

export const BadgeVariants: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-2">
      {BADGES.map((b) => (
        <SelectablePresetCard
          key={b}
          title={`Preset (${b})`}
          subtitle="provider / model"
          badge={b}
          badgeLabel={b}
        />
      ))}
    </div>
  ),
}
