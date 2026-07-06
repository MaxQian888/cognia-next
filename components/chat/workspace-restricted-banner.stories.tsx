import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkspaceRestrictedBanner } from "./workspace-restricted-banner"
import type { WorkspaceRoot } from "@/types/workspace"

// Persistent banner shown above the conversation while the active workspace is
// in Restricted Mode (any root untrusted). Renders nothing when all are trusted.
const root = (id: string, path: string): WorkspaceRoot => ({ id, path })

const meta = {
  title: "Chat/WorkspaceRestrictedBanner",
  component: WorkspaceRestrictedBanner,
  parameters: { layout: "padded" },
  args: {
    untrustedRoots: [root("root-1", "/Users/dev/projects/cognia-next")],
    onTrust: fn(),
  },
} satisfies Meta<typeof WorkspaceRestrictedBanner>

export default meta
type Story = StoryObj<typeof meta>

/** A single untrusted root. */
export const SingleRoot: Story = {}

/** Multiple untrusted roots are all listed. */
export const MultipleRoots: Story = {
  args: {
    untrustedRoots: [
      root("root-1", "/Users/dev/projects/cognia-next"),
      root("root-2", "/Users/dev/projects/shared-lib"),
      root("root-3", "/tmp/scratch"),
    ],
  },
}

/** No untrusted roots → the banner renders nothing. */
export const AllTrusted: Story = {
  args: { untrustedRoots: [] },
}
