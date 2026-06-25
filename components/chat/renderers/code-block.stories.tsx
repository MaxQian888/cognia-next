import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { CodeBlock } from "./code-block"

const SAMPLE = `export function greet(name: string): string {
  // A friendly greeting
  const trimmed = name.trim()
  if (!trimmed) return "Hello, stranger!"
  return \`Hello, \${trimmed}!\`
}`

const meta = {
  title: "Chat/Renderers/CodeBlock",
  component: CodeBlock,
  args: { code: SAMPLE, language: "typescript" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof CodeBlock>

export default meta
type Story = StoryObj<typeof meta>

export const TypeScript: Story = {}

export const WithLineNumbers: Story = {
  args: { showLineNumbers: true, filename: "greet.ts" },
}

export const HighlightedLines: Story = {
  args: { showLineNumbers: true, highlightLines: [2, 4] },
}

// While streaming, Shiki is skipped — plain <pre> with line numbers.
export const Streaming: Story = {
  args: { isStreaming: true },
}

export const PlainText: Story = {
  args: { code: "no language → plain text\nsecond line", language: undefined },
}
