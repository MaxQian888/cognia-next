import type { Meta, StoryObj } from "@storybook/nextjs"

import { MarkdownRenderer } from "./markdown-renderer"

// Full-featured markdown rendering for completed messages: GFM, code blocks,
// tables, task lists, GitHub-style alerts, math, mermaid, and media embeds.
const meta = {
  title: "Chat/MarkdownRenderer",
  component: MarkdownRenderer,
  parameters: { layout: "padded" },
  args: {
    content:
      "## Hello\n\nThis is **markdown** with a [link](https://example.com) and `inline code`.",
  },
} satisfies Meta<typeof MarkdownRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const Basic: Story = {}

/** Headings, lists, a table, a quote, and a fenced code block. */
export const RichDocument: Story = {
  args: {
    content: [
      "# Promise vs async/await",
      "",
      "Both are the same underneath — **async/await is syntax sugar**.",
      "",
      "| Dimension | Promise | async/await |",
      "| --- | --- | --- |",
      "| Readability | chained `.then()` | synchronous style |",
      "| Errors | `.catch()` | `try/catch` |",
      "",
      "1. `await` only inside `async` functions",
      "2. Use `Promise.all` to fan out",
      "",
      "> Tip: `for...of` + `await` runs serially.",
      "",
      "```ts",
      "const [a, b] = await Promise.all([fetchA(), fetchB()])",
      "```",
    ].join("\n"),
  },
}

/** GFM task list — checked and unchecked items. */
export const TaskList: Story = {
  args: {
    content: ["- [x] Read the file", "- [x] Apply the edit", "- [ ] Run the tests"].join("\n"),
  },
}

/** GitHub-style alert from a `> [!WARNING]` blockquote. */
export const Alert: Story = {
  args: {
    content:
      '> [!WARNING]\n> Do not remove `output: "export"` — Tauri and Capacitor both consume it.',
  },
}

/** Math rendering can be disabled per-call. */
export const PlainNoMath: Story = {
  args: {
    enableMath: false,
    content: "Just plain text, no `$x^2$` math processing.",
  },
}
