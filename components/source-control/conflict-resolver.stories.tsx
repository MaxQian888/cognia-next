import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConflictResolver } from "./conflict-resolver"
import { makeConflict } from "@/lib/storybook/fixtures/source-control"

// Monaco mounts async into the sized container; the accept-ours/theirs/both
// toolbar renders synchronously above it.
const meta = {
  title: "SourceControl/ConflictResolver",
  component: ConflictResolver,
  args: {
    conflict: makeConflict(),
    onResolve: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConflictResolver>

export default meta
type Story = StoryObj<typeof meta>

export const JsonConflict: Story = {}

export const CodeConflict: Story = {
  args: {
    conflict: makeConflict({
      path: "src/lib/feature-flags.ts",
      ours: "export const FLAGS = {\n  diffViewer: true,\n  blame: false,\n}\n",
      theirs: "export const FLAGS = {\n  diffViewer: true,\n  blame: true,\n  graph: true,\n}\n",
      base: "export const FLAGS = {\n  diffViewer: true,\n}\n",
    }),
  },
}
