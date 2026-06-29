import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DiffViewer } from "./diff-viewer"
import { makeDiff, makeHunk } from "@/lib/storybook/fixtures/source-control"

// The Monaco `DiffEditor` mounts async (dynamic, ssr:false) into the sized
// container. The empty/binary branches render synchronously with no editor.
const meta = {
  title: "SourceControl/DiffViewer",
  component: DiffViewer,
  args: {
    diff: makeDiff(),
    staged: false,
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiffViewer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithHunkActions: Story = {
  args: {
    diff: makeDiff({
      hunks: [makeHunk(), makeHunk({ header: "@@ -20,3 +24,5 @@", newStart: 24 })],
    }),
    hunkActions: [
      { icon: "stage", label: "Stage hunk", onClick: fn() },
      { icon: "discard", label: "Discard hunk", onClick: fn() },
    ],
  },
}

export const NoSelection: Story = { args: { diff: null } }

export const Binary: Story = {
  args: { diff: makeDiff({ path: "assets/logo.png", isBinary: true, language: null }) },
}
