import type { ComponentProps } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { BranchPicker } from "./branch-picker"
import type { GitBranch } from "@/types/git"

type BranchPickerProps = ComponentProps<typeof BranchPicker>

const branch = (name: string, over: Partial<GitBranch> = {}): GitBranch => ({
  name,
  isCurrent: false,
  isRemote: false,
  checkedOutIn: null,
  checkoutLocked: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  ...over,
})

const branches: GitBranch[] = [
  branch("main", { isCurrent: true, upstream: "origin/main" }),
  branch("dev", { ahead: 3, behind: 1 }),
  branch("feature/storybook"),
  branch("origin/main", { isRemote: true }),
  branch("origin/release-1.2", { isRemote: true }),
]

const actions: BranchPickerProps["actions"] = {
  checkout: fn(),
  createBranch: fn(),
  deleteBranch: fn(),
  renameBranch: fn(),
  rebase: fn(),
  merge: fn(),
}

const meta = {
  title: "SourceControl/BranchPicker",
  component: BranchPicker,
  args: { branches, actions, onPicked: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchPicker>

export default meta
type Story = StoryObj<typeof meta>

export const LocalAndRemote: Story = {}

export const SingleBranch: Story = {
  args: { branches: [branch("main", { isCurrent: true })] },
}

export const Empty: Story = { args: { branches: [] } }
