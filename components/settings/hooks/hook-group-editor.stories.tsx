import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { HookGroupEditor } from "./hook-group-editor"
import type { HookGroup } from "@/lib/claude/hooks"

// Controlled editor for a single `HookGroup` (matcher regex + handler list).
// The stories wrap it in local state so the matcher field and the nested
// handler forms behave interactively in the preview.
function Harness({ initial }: { initial: HookGroup }) {
  const [value, setValue] = useState<HookGroup>(initial)
  return (
    <div className="max-w-xl">
      <HookGroupEditor value={value} onChange={setValue} onRemove={fn()} />
    </div>
  )
}

const meta = {
  title: "Settings/Hooks/HookGroupEditor",
  component: HookGroupEditor,
  parameters: { layout: "padded" },
  args: { value: { matcher: "", hooks: [] }, onChange: fn(), onRemove: fn() },
} satisfies Meta<typeof HookGroupEditor>

export default meta
type Story = StoryObj<typeof meta>

// Empty matcher (match all) with no handlers yet.
export const Empty: Story = {
  render: () => <Harness initial={{ matcher: "", hooks: [] }} />,
}

// A matcher targeting Bash/Edit with one command handler configured.
export const WithCommandHandler: Story = {
  render: () => (
    <Harness
      initial={{
        matcher: "Bash|Edit",
        hooks: [{ type: "command", command: 'echo "about to run a tool"', timeout: 5000 }],
      }}
    />
  ),
}

// An invalid regex matcher surfaces the inline validation error.
export const InvalidMatcher: Story = {
  render: () => <Harness initial={{ matcher: "Bash(", hooks: [] }} />,
}
