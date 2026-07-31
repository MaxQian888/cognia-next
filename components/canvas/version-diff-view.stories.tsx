import type { Meta, StoryObj } from "@storybook/nextjs"

import { VersionDiffView } from "./version-diff-view"

// VersionDiffView is a pure diff renderer: given old/new content (or two
// versions) it computes a line diff and shows it inline, side-by-side, or
// unified, with a `+N -M` stats badge bar at the top.
const OLD = `function add(a, b) {
  return a + b
}

const total = add(1, 2)
`

const NEW = `function add(a: number, b: number): number {
  // sum two numbers
  return a + b
}

const total = add(1, 2)
console.log(total)
`

const meta = {
  title: "Canvas/VersionDiffView",
  component: VersionDiffView,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VersionDiffView>

export default meta
type Story = StoryObj<typeof meta>

// Inline diff with labels above the stats bar.
export const Inline: Story = {
  args: {
    oldContent: OLD,
    newContent: NEW,
    oldLabel: "v1 — initial",
    newLabel: "v2 — typed + logging",
    mode: "inline",
  },
}

// Side-by-side comparison of the two snapshots.
export const SideBySide: Story = {
  args: {
    oldContent: OLD,
    newContent: NEW,
    oldLabel: "Before",
    newLabel: "After",
    mode: "side-by-side",
  },
}

// Identical content → empty diff, renders the "no changes" message.
export const NoChanges: Story = {
  args: {
    oldContent: OLD,
    newContent: OLD,
    mode: "inline",
  },
}

// Pure additions (new file from empty) — every line is green.
export const AllAdded: Story = {
  args: {
    oldContent: "",
    newContent: NEW,
    newLabel: "New document",
    mode: "inline",
  },
}
