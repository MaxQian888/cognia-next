import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LightCodeEditor } from "./light-code-editor"

const TS = `export function rateLimit(max: number, windowMs: number) {
  const hits: number[] = []
  return () => {
    const now = Date.now()
    while (hits.length && now - hits[0] > windowMs) hits.shift()
    if (hits.length >= max) return false
    hits.push(now)
    return true
  }
}
`

const BROKEN_JSON = `{
  "name": "cognia",
  "version": "1.0.0",
  "scripts": {
    "dev": "next dev"
  // missing closing brace
`

// Shared CodeMirror 6 editor (the mobile-friendly Monaco alternative): syntax
// highlighting, line numbers, history, find/replace, and in-browser diagnostics.
const meta = {
  title: "Editor/LightCodeEditor",
  component: LightCodeEditor,
  args: { onChange: fn(), language: "typescript", value: TS },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[400px] w-[640px] flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LightCodeEditor>

export default meta
type Story = StoryObj<typeof meta>

export const TypeScript: Story = {}

// Invalid JSON → the in-browser linter surfaces an error in the status bar.
export const JsonWithError: Story = {
  args: { language: "json", value: BROKEN_JSON },
}

export const ReadOnly: Story = {
  args: { readOnly: true },
}
