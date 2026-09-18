import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { FileToolPart } from "./file-tool-part"

const toolPart = (
  type: string,
  state: ToolUIPart["state"],
  extra: Record<string, unknown> = {}
): ToolUIPart =>
  ({
    type,
    toolCallId: "call-1",
    state,
    input: {},
    ...extra,
  }) as unknown as ToolUIPart

const meta = {
  title: "Chat/MessageParts/FileToolPart",
  component: FileToolPart,
  parameters: { layout: "padded" },
} satisfies Meta<typeof FileToolPart>

export default meta
type Story = StoryObj<typeof meta>

// Read — collapsed row; click to expand the themed code block.
export const Read: Story = {
  args: {
    part: toolPart("tool-Read", "output-available", {
      input: { file_path: "components/chat/message-renderer.tsx" },
      output:
        'import { memo } from "react"\nimport type { ToolUIPart } from "ai"\n\nexport function render() {}',
    }),
  },
}

// Read mid-flight — breathing dot + shimmering target, body open.
export const ReadRunning: Story = {
  args: {
    part: toolPart("tool-Read", "input-available", {
      input: { file_path: "lib/chat/tool-summary.ts" },
    }),
  },
}

// Write — settled row reporting the written line count.
export const Write: Story = {
  args: {
    part: toolPart("tool-Write", "output-available", {
      input: {
        file_path: "lib/new-module.ts",
        content: "export const x = 1\nexport const y = 2\nexport const z = 3\n",
      },
      output: "File created successfully",
    }),
  },
}

// Edit — expands to the diff preview.
export const Edit: Story = {
  args: {
    defaultOpen: true,
    part: toolPart("tool-Edit", "output-available", {
      input: {
        file_path: "lib/chat/tool-summary.ts",
        old_string: "export function old() {}",
        new_string: "export function renamed() {}",
      },
      output: "The file has been updated",
    }),
  },
}

// Grep — pattern + scope in the target, match count in the meta.
export const Grep: Story = {
  args: {
    part: toolPart("tool-Grep", "output-available", {
      input: { pattern: "isFileToolPart", glob: "*.tsx" },
      output:
        "components/chat/message-parts/file-tool-part.tsx:77:export function isFileToolPart\ncomponents/chat/message-parts/tool-detail-body.tsx:94:  if (isFileToolPart(part))",
    }),
  },
}

// Glob — file-count meta; expands to the match list.
export const Glob: Story = {
  args: {
    part: toolPart("tool-Glob", "output-available", {
      input: { pattern: "components/chat/message-parts/*.tsx" },
      output: "a.tsx\nb.tsx\nc.tsx\nd.tsx",
    }),
  },
}

// Large read — the expansion clamps to the preview budget and offers
// "Show all" instead of dumping the full file into the message stream.
export const ReadLargeFile: Story = {
  args: {
    defaultOpen: true,
    part: toolPart("tool-Read", "output-available", {
      input: { file_path: "lib/chat/large-module.ts" },
      output: Array.from(
        { length: 300 },
        (_, i) => `export const symbol${i} = compute(${i}) // line ${i + 1}`
      ).join("\n"),
    }),
  },
}

// Large multi-edit — the edits list itself clamps past twenty entries.
export const MultiEditLarge: Story = {
  args: {
    defaultOpen: true,
    part: toolPart("tool-MultiEdit", "output-available", {
      input: {
        file_path: "lib/chat/generated.ts",
        edits: Array.from({ length: 24 }, (_, i) => ({
          old_string: `old${i}`,
          new_string: `new${i}`,
        })),
      },
      output: "Applied 24 edits",
    }),
  },
}

// Failed call — red dot, error meta, auto-opened parsed trace.
export const WriteError: Story = {
  args: {
    part: toolPart("tool-Write", "output-error", {
      input: { file_path: "/etc/hosts", content: "x" },
      errorText: "EACCES: permission denied, open '/etc/hosts'",
    }),
  },
}
