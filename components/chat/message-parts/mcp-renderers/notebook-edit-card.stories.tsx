import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { NotebookEditCard } from "./notebook-edit-card"

function makePart(input: unknown): ToolUIPart {
  return {
    type: "tool-NotebookEdit",
    toolCallId: "nb-1",
    state: "output-available",
    input,
    output: "Edited cell",
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/NotebookEditCard",
  component: NotebookEditCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof NotebookEditCard>

export default meta
type Story = StoryObj<typeof meta>

// Python code cell — meta line shows edit_mode · cell_type · cell id.
export const CodeCell: Story = {
  args: {
    part: makePart({
      notebook_path: "/repo/notebooks/analysis.ipynb",
      cell_id: "a1b2",
      edit_mode: "replace",
      cell_type: "code",
      new_source: "import pandas as pd\ndf = pd.read_csv('data.csv')\ndf.head()",
    }),
  },
}

// Markdown cell — source highlighted as markdown instead of python.
export const MarkdownCell: Story = {
  args: {
    part: makePart({
      notebook_path: "/repo/notebooks/report.ipynb",
      edit_mode: "insert",
      cell_type: "markdown",
      new_source: "# Results\n\nThe model reached **0.92** accuracy.",
    }),
  },
}
