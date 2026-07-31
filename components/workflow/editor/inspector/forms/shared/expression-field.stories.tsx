import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ExpressionField } from "./expression-field"

// CodeMirror-backed field for `{{ }}` expressions. Without an editor store it
// renders fully — just without graph-aware completions — and the live-preview
// footer resolves against an (empty) latest-run snapshot. The wrapper makes it
// a controlled string editor.
function Controlled({
  initial = "",
  multiline = false,
  placeholder,
}: {
  initial?: string
  multiline?: boolean
  placeholder?: string
}) {
  const [value, setValue] = React.useState(initial)
  return (
    <div className="w-[360px]">
      <ExpressionField
        value={value}
        onChange={setValue}
        multiline={multiline}
        placeholder={placeholder}
      />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/Shared/ExpressionField",
  component: ExpressionField,
  parameters: { layout: "padded" },
  args: { value: "", onChange: fn() },
} satisfies Meta<typeof ExpressionField>

export default meta
type Story = StoryObj<typeof meta>

// Single-line compact mode with a plain value.
export const SingleLine: Story = {
  render: () => <Controlled initial="origin" placeholder="remote name" />,
}

// An expression value — the preview footer attempts to resolve it.
export const WithExpression: Story = {
  render: () => <Controlled initial="Hello {{ $json.name }}, your order shipped" />,
}

// Multiline mode renders line numbers and a taller editor.
export const Multiline: Story = {
  render: () => (
    <Controlled multiline initial={"{{ $node['summarize'].out.text }}\n\nSent at {{ $now }}"} />
  ),
}

// Empty editor with a placeholder.
export const Empty: Story = {
  render: () => <Controlled placeholder="{{ $node['id'].out.field }}" />,
}
