import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { EditCard } from "./edit-card"

function makePart(input: unknown, output?: unknown): ToolUIPart {
  return {
    type: "tool-Edit",
    toolCallId: "edit-1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/EditCard",
  component: EditCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof EditCard>

export default meta
type Story = StoryObj<typeof meta>

// Single old_string/new_string edit with a result line under the diff.
export const SingleEdit: Story = {
  args: {
    part: makePart(
      {
        file_path: "lib/utils.ts",
        old_string: "return clsx(inputs)",
        new_string: "return twMerge(clsx(inputs))",
      },
      "Applied 1 edit to lib/utils.ts"
    ),
  },
}

// multi_edit shape — an `edits[]` array renders a diff per entry + edit count.
export const MultiEdit: Story = {
  args: {
    part: makePart({
      file_path: "components/footer.tsx",
      edits: [
        { old_string: 'className="p-2"', new_string: 'className="p-4"' },
        {
          old_string: "© 2024 Cognia",
          new_string: "© 2026 Cognia",
          replace_all: true,
        },
      ],
    }),
  },
}
