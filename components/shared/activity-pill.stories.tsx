import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { InfinityIcon, PauseIcon, PlayIcon, Settings2Icon, SquareIcon } from "lucide-react"

import { ActivityPill, type ActivityPillProps } from "./activity-pill"

const runningChip: ActivityPillProps["chip"] = {
  label: "Running",
  chipClassName: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  dotClassName: "bg-emerald-500",
  pulse: true,
}

const pausedChip: ActivityPillProps["chip"] = {
  label: "Paused",
  chipClassName: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  dotClassName: "bg-amber-500",
}

const actions: ActivityPillProps["actions"] = [
  { id: "pause", icon: <PauseIcon />, label: "Pause", onClick: fn(), primary: true },
  { id: "stop", icon: <SquareIcon />, label: "Stop", onClick: fn() },
  { id: "settings", icon: <Settings2Icon />, label: "Settings", onClick: fn() },
]

const meta = {
  title: "Shared/ActivityPill",
  component: ActivityPill,
  args: {
    icon: <InfinityIcon className="size-4" />,
    title: "Goal loop · refactor the renderer",
    chip: runningChip,
    ariaLabel: "Background activity",
    moreLabel: "More actions",
    actions,
  },
} satisfies Meta<typeof ActivityPill>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {
  args: {
    subtext: "Iteration 3 of 10 · 42s elapsed",
    footnote: "Next continuation at 14:30",
  },
}

export const Paused: Story = {
  args: {
    chip: pausedChip,
    subtext: "Iteration 3 of 10 · paused by user",
    actions: [
      { id: "resume", icon: <PlayIcon />, label: "Resume", onClick: fn(), primary: true },
      { id: "stop", icon: <SquareIcon />, label: "Stop", onClick: fn() },
    ],
  },
}

export const Minimal: Story = {
  args: {
    title: "Watching CI",
    actions: [{ id: "stop", icon: <SquareIcon />, label: "Stop", onClick: fn(), primary: true }],
  },
}

export const LongTitleTruncation: Story = {
  args: {
    title:
      "Goal loop · investigate why the static export bundles the server-only vector store SDK across the entire chat composer module graph",
    titleTooltip: "Full title shown on hover",
    subtext: "Iteration 1 of 25",
    className: "max-w-sm",
  },
}
