import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DesktopActionForm } from "./desktop-action-form"

// `DesktopActionForm` is the shared chrome behind every `action.desktop.*`
// inspector form: a selector textarea plus timeout/retries, with per-kind
// `extraFields` injected below. The wrapper keeps it interactive.
function Controlled({
  initial = {},
  ...rest
}: {
  initial?: Record<string, unknown>
  selectorHint?: string
  showSelector?: boolean
  extraFields?: React.ReactNode
  selectorPlaceholder?: string
}) {
  const [params, setParams] = React.useState<Record<string, unknown>>(initial)
  return (
    <div className="w-[360px]">
      <DesktopActionForm params={params} onChange={setParams} {...rest} />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/Desktop/ActionForm",
  component: DesktopActionForm,
  parameters: { layout: "padded" },
  args: { params: {}, onChange: fn() },
} satisfies Meta<typeof DesktopActionForm>

export default meta
type Story = StoryObj<typeof meta>

// The shared block on its own — selector + timeout + retries.
export const Default: Story = {
  render: () => (
    <Controlled initial={{ selector: 'role:Button name:"Save"', timeoutMs: 5000, retries: 1 }} />
  ),
}

// A node that operates on the foreground window hides the selector input.
export const WithoutSelector: Story = {
  render: () => <Controlled showSelector={false} initial={{ timeoutMs: 3000, retries: 0 }} />,
}

// Per-kind `extraFields` render below the shared block.
export const WithExtraFields: Story = {
  render: () => (
    <Controlled
      initial={{ selector: "automationId:submitBtn", timeoutMs: 8000, retries: 2 }}
      extraFields={
        <p className="text-[11px] text-muted-foreground">
          Per-kind fields render here (e.g. text, pattern, click count).
        </p>
      }
    />
  ),
}
