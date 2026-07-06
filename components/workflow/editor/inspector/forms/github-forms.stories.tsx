import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  GithubWebhookTriggerConfig,
  GithubOpenPrConfig,
  GithubClosePrConfig,
  GithubMergePrConfig,
  GithubReviewPrConfig,
  GithubReviewPrInlineConfig,
} from "./github-forms"

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
    <div className="w-[380px]">
      <Form params={params} onChange={setParams} />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/GitHub",
  component: GithubOpenPrConfig,
  parameters: { layout: "padded" },
  args: { params: {}, onChange: fn() },
} satisfies Meta<typeof GithubOpenPrConfig>

export default meta
type Story = StoryObj<typeof meta>

// trigger.github.webhook — repo + subscribed events.
export const WebhookTrigger: Story = {
  render: () => (
    <Controlled
      Form={GithubWebhookTriggerConfig}
      initial={{
        repoFullName: "acme/widgets",
        events: ["pull_request.opened", "issues.opened"],
      }}
    />
  ),
}

// action.github.openPr — head/base/title/body + draft toggle.
export const OpenPr: Story = {
  render: () => (
    <Controlled
      Form={GithubOpenPrConfig}
      initial={{
        repoFullName: "acme/widgets",
        head: "feature/{{ $json.branch }}",
        base: "main",
        title: "Add nightly digest",
        body: "Automated PR from the digest workflow.",
        draft: false,
      }}
    />
  ),
}

// action.github.closePr — repo + PR number.
export const ClosePr: Story = {
  render: () => (
    <Controlled
      Form={GithubClosePrConfig}
      initial={{ repoFullName: "acme/widgets", prNumber: 42 }}
    />
  ),
}

// action.github.mergePr — merge method select + commit title.
export const MergePr: Story = {
  render: () => (
    <Controlled
      Form={GithubMergePrConfig}
      initial={{ repoFullName: "acme/widgets", prNumber: 42, mergeMethod: "squash" }}
    />
  ),
}

// action.github.reviewPr — review event with a body.
export const ReviewPr: Story = {
  render: () => (
    <Controlled
      Form={GithubReviewPrConfig}
      initial={{ repoFullName: "acme/widgets", prNumber: 42, event: "APPROVE" }}
    />
  ),
}

// action.github.reviewPrInline — inline review comments.
export const ReviewPrInline: Story = {
  render: () => (
    <Controlled
      Form={GithubReviewPrInlineConfig}
      initial={{ repoFullName: "acme/widgets", prNumber: 42, event: "REQUEST_CHANGES" }}
    />
  ),
}
