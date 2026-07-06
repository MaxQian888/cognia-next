import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { Newspaper, GraduationCap, Image as ImageIcon } from "lucide-react"

import { SegmentedControl, type SegmentedOption } from "./segmented-control"

// `SegmentedControl` is a pure, controlled radio-style toggle group. `inline`
// renders compact label-only pills; `cards` renders a responsive grid with an
// optional icon + description per option. Value is owned by the caller, so each
// story fixes a `value` and reports changes via `onValueChange`.
const INLINE_OPTIONS: SegmentedOption<string>[] = [
  { value: "general", label: "General" },
  { value: "news", label: "News" },
  { value: "academic", label: "Academic" },
  { value: "images", label: "Images" },
]

const CARD_OPTIONS: SegmentedOption<string>[] = [
  { value: "basic", label: "Basic", description: "Fast, single pass" },
  { value: "advanced", label: "Advanced", description: "Deeper crawl" },
  { value: "deep", label: "Deep", description: "Exhaustive research" },
]

const ICON_OPTIONS: SegmentedOption<string>[] = [
  { value: "news", label: "News", icon: <Newspaper className="h-5 w-5" /> },
  { value: "academic", label: "Academic", icon: <GraduationCap className="h-5 w-5" /> },
  { value: "images", label: "Images", icon: <ImageIcon className="h-5 w-5" /> },
]

const meta = {
  title: "Settings/Search/Shared/SegmentedControl",
  component: SegmentedControl,
  parameters: { layout: "padded" },
  args: {
    value: "general",
    options: INLINE_OPTIONS,
    onValueChange: fn(),
    "aria-label": "Search type",
  },
  decorators: [
    (Story) => (
      <div className="max-w-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SegmentedControl>

export default meta
type Story = StoryObj<typeof meta>

export const Inline: Story = {}

export const Cards: Story = {
  args: {
    variant: "cards",
    value: "advanced",
    options: CARD_OPTIONS,
    "aria-label": "Search depth",
  },
}

export const CardsWithIcons: Story = {
  args: {
    variant: "cards",
    value: "academic",
    options: ICON_OPTIONS,
    "aria-label": "Verification mode",
  },
}

export const Disabled: Story = {
  args: { disabled: true, value: "news" },
}
