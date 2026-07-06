import type { ComponentProps } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { CheckIcon, MinusIcon, Trash2Icon } from "lucide-react"

import { ChangeGroup } from "./change-group"
import { ChangeItem } from "./change-item"
import { makeChange } from "@/lib/storybook/fixtures/source-control"

type ChangeGroupProps = ComponentProps<typeof ChangeGroup>

// A few rows to fill the expanded body — the group only owns the header +
// collapse; the children are arbitrary.
function rows(staged: boolean) {
  return (["modified", "added", "deleted"] as const).map((s) => (
    <ChangeItem
      key={s}
      change={makeChange(s, { path: `src/${s}-file.ts`, staged })}
      selected={false}
      onSelect={fn()}
      onCopyPath={fn()}
    />
  ))
}

const meta = {
  title: "SourceControl/ChangeGroup",
  component: ChangeGroup,
  args: {
    group: "changes",
    count: 3,
    expanded: true,
    onToggle: fn(),
    children: rows(false),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-80 rounded-md border p-1">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChangeGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Changes: Story = {}

export const Collapsed: Story = { args: { expanded: false } }

export const Staged: Story = {
  args: {
    group: "staged",
    count: 3,
    children: rows(true),
    actions: [
      {
        key: "unstage-all",
        label: "Unstage all",
        icon: <MinusIcon className="size-3" />,
        onClick: fn(),
      },
    ],
  },
}

export const ChangesWithActions: Story = {
  args: {
    actions: [
      {
        key: "stage-all",
        label: "Stage all",
        icon: <CheckIcon className="size-3" />,
        onClick: fn(),
      },
      {
        key: "discard-all",
        label: "Discard all",
        icon: <Trash2Icon className="size-3" />,
        destructive: true,
        onClick: fn(),
      },
    ] satisfies ChangeGroupProps["actions"],
  },
}

export const MergeConflicts: Story = {
  args: {
    group: "merge",
    count: 1,
    children: (
      <ChangeItem
        change={makeChange("conflicted", { path: "i18n/messages/en.json", group: "merge" })}
        selected
        onSelect={fn()}
        onCopyPath={fn()}
      />
    ),
  },
}
