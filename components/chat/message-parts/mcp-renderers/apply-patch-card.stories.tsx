import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { ApplyPatchCard } from "./apply-patch-card"

const PATCH = [
  "diff --git a/lib/utils.ts b/lib/utils.ts",
  "--- a/lib/utils.ts",
  "+++ b/lib/utils.ts",
  "@@ -1,6 +1,7 @@",
  ' import { clsx, type ClassValue } from "clsx"',
  '+import { twMerge } from "tailwind-merge"',
  " ",
  " export function cn(...inputs: ClassValue[]) {",
  "-  return clsx(inputs)",
  "+  return twMerge(clsx(inputs))",
  " }",
  " ",
  "diff --git a/lib/format.ts b/lib/format.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/lib/format.ts",
  "@@ -0,0 +1,3 @@",
  "+export function formatBytes(n: number): string {",
  "+  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`",
  "+}",
  "diff --git a/lib/legacy.ts b/lib/legacy.ts",
  "deleted file mode 100644",
  "--- a/lib/legacy.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-// unused",
  "-export const legacy = true",
].join("\n")

function makePart(patch: string, state: ToolUIPart["state"] = "output-available"): ToolUIPart {
  return {
    type: "tool-apply_patch",
    toolCallId: "patch-1",
    state,
    input: { patch },
    output:
      state === "output-available"
        ? "Applied patch to 3 files:\nupdated lib/utils.ts\ncreated lib/format.ts\ndeleted lib/legacy.ts"
        : undefined,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/ApplyPatchCard",
  component: ApplyPatchCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ApplyPatchCard>

export default meta
type Story = StoryObj<typeof meta>

/** A landed multi-file patch: created / modified / deleted, each with its hunks. */
export const MultiFile: Story = {
  args: { part: makePart(PATCH), sessionId: "story-session" },
}

/** Still waiting for approval: the same diffs, no review routes yet. */
export const Pending: Story = {
  args: { part: makePart(PATCH, "input-available"), sessionId: "story-session" },
}

/** A rename with no text change and a binary file: each says why it has no lines. */
export const RenameAndBinary: Story = {
  args: {
    part: makePart(
      [
        "diff --git a/old-name.ts b/new-name.ts",
        "similarity index 100%",
        "rename from old-name.ts",
        "rename to new-name.ts",
        "diff --git a/logo.png b/logo.png",
        "Binary files a/logo.png and b/logo.png differ",
      ].join("\n")
    ),
  },
}
