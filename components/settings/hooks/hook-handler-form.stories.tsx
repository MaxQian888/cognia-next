import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { HookHandlerForm } from "./hook-handler-form"
import type { HookHandler } from "@/lib/claude/hooks"

// Controlled discriminated form for a `HookHandler` — `command` or `webhook`.
// Switching the type select swaps the field set; the stories keep local state
// so the type toggle and the header editor behave interactively.
function Harness({ initial }: { initial: HookHandler }) {
  const [value, setValue] = useState<HookHandler>(initial)
  return (
    <div className="max-w-md">
      <HookHandlerForm value={value} onChange={setValue} onRemove={fn()} />
    </div>
  )
}

const meta = {
  title: "Settings/Hooks/HookHandlerForm",
  component: HookHandlerForm,
  parameters: { layout: "padded" },
  args: { value: { type: "command", command: "" }, onChange: fn(), onRemove: fn() },
} satisfies Meta<typeof HookHandlerForm>

export default meta
type Story = StoryObj<typeof meta>

// Command handler: a shell command textarea + optional timeout.
export const Command: Story = {
  render: () => <Harness initial={{ type: "command", command: "pnpm lint", timeout: 30000 }} />,
}

// Webhook handler: URL input + a custom headers editor with two rows.
export const Webhook: Story = {
  render: () => (
    <Harness
      initial={{
        type: "webhook",
        url: "https://hooks.example.com/notify",
        headers: { "X-Token": "abc123", "Content-Type": "application/json" },
      }}
    />
  ),
}
