import type { ComponentProps } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { BranchHeader } from "./branch-header"

type BranchHeaderProps = ComponentProps<typeof BranchHeader>

// The BranchPicker (and thus the branches/actions) only mounts when the popover
// opens; the chip itself renders from branch/ahead/behind. Pass stub actions.
const actions: BranchHeaderProps["actions"] = {
  checkout: fn(),
  createBranch: fn(),
  deleteBranch: fn(),
  renameBranch: fn(),
  rebase: fn(),
  merge: fn(),
}

const meta = {
  title: "SourceControl/BranchHeader",
  component: BranchHeader,
  args: { branch: "main", ahead: 0, behind: 0, branches: [], actions },
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Clean: Story = {}
export const AheadOnly: Story = { args: { ahead: 3, behind: 0 } }
export const BehindOnly: Story = { args: { ahead: 0, behind: 2 } }
export const AheadAndBehind: Story = { args: { ahead: 3, behind: 2 } }

export const Detached: Story = { args: { branch: null } }

export const LongBranchName: Story = {
  args: { branch: "feature/storybook-pilot-and-i18n-key-backfill-for-chat", ahead: 1 },
}
