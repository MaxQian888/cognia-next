import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowCredentialsList } from "./workflow-credentials-list"
import type { WorkflowCredentialRef } from "@/types/workflow/visual"

// Manages workflow credential references (id / name / kind) — never the secret
// values, which the orchestrator resolves from the OS keyring at run time. Pure
// value/onChange.
function Controlled({ initial = {} }: { initial?: Record<string, WorkflowCredentialRef> }) {
  const [value, setValue] = React.useState<Record<string, WorkflowCredentialRef>>(initial)
  return (
    <div className="w-[420px]">
      <WorkflowCredentialsList value={value} onChange={setValue} />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Settings/WorkflowCredentialsList",
  component: WorkflowCredentialsList,
  parameters: { layout: "padded" },
  args: { value: {}, onChange: fn() },
} satisfies Meta<typeof WorkflowCredentialsList>

export default meta
type Story = StoryObj<typeof meta>

// Two credential references.
export const WithCredentials: Story = {
  render: () => (
    <Controlled
      initial={{
        gh_token: { id: "gh_token", name: "GitHub PAT", kind: "github" },
        openai: { id: "openai", name: "OpenAI key", kind: "api-key" },
      }}
    />
  ),
}

// Empty — add the first credential reference.
export const Empty: Story = {
  render: () => <Controlled />,
}
