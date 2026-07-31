import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { EvalRunConfig, EvalGateConfig } from "./eval-forms"

type ConfigForm = React.ComponentType<{
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}>

function Controlled({
  Form,
  initial = {},
}: {
  Form: ConfigForm
  initial?: Record<string, unknown>
}) {
  const [params, setParams] = React.useState<Record<string, unknown>>(initial)
  return (
    <div className="w-[360px]">
      <Form params={params} onChange={setParams} />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/Eval",
  component: EvalRunConfig,
  parameters: { layout: "padded" },
  args: { params: {}, onChange: fn() },
} satisfies Meta<typeof EvalRunConfig>

export default meta
type Story = StoryObj<typeof meta>

// eval.run targeting a chat model — the "chat" branch reveals model +
// character fields.
export const RunChat: Story = {
  render: () => (
    <Controlled
      Form={EvalRunConfig}
      initial={{
        datasetId: "ds_support_qa",
        targetKind: "chat",
        model: "claude-sonnet-4",
        label: "Nightly regression",
        k: 3,
        scorerIds: ["exact-match", "llm-judge"],
      }}
    />
  ),
}

// eval.run targeting a workflow — the branch swaps in a workflowId field.
export const RunWorkflow: Story = {
  render: () => (
    <Controlled
      Form={EvalRunConfig}
      initial={{ datasetId: "ds_pipeline", targetKind: "workflow", workflowId: "{{ $vars.wfId }}" }}
    />
  ),
}

// eval.gate — pass/fail thresholds against a prior eval run.
export const Gate: Story = {
  render: () => (
    <Controlled
      Form={EvalGateConfig}
      initial={{ runId: "{{ $node['eval'].out.runId }}", minPassAt1: 0.8, maxTotalCostUsd: 2.5 }}
    />
  ),
}
