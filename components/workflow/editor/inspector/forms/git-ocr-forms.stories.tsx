import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  GitStageConfig,
  GitCommitConfig,
  GitPushConfig,
  GitBranchConfig,
  OcrExtractConfig,
} from "./git-ocr-forms"

// All of these forms share the same `{ params, onChange }` contract and edit a
// loosely-typed params bag in place. A tiny controlled wrapper keeps the inputs
// interactive in the Storybook canvas (typing/toggling round-trips through
// state), while each story seeds a realistic starting params object.
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
  title: "Workflow/Editor/Inspector/Forms/Git & OCR",
  component: GitCommitConfig,
  parameters: { layout: "padded" },
  args: { params: {}, onChange: fn() },
} satisfies Meta<typeof GitCommitConfig>

export default meta
type Story = StoryObj<typeof meta>

// action.git.stage — repo path + comma-separated paths to stage.
export const Stage: Story = {
  render: () => (
    <Controlled Form={GitStageConfig} initial={{ paths: ["src/index.ts", "README.md"] }} />
  ),
}

// action.git.commit — message (required) + sign-off toggle.
export const Commit: Story = {
  render: () => (
    <Controlled
      Form={GitCommitConfig}
      initial={{ message: "chore: nightly snapshot {{ $now }}", signoff: true }}
    />
  ),
}

// action.git.push — remote / branch / set-upstream.
export const Push: Story = {
  render: () => (
    <Controlled
      Form={GitPushConfig}
      initial={{ remote: "origin", branch: "main", setUpstream: false }}
    />
  ),
}

// action.git.branch — name (required), base, and checkout toggle.
export const Branch: Story = {
  render: () => (
    <Controlled
      Form={GitBranchConfig}
      initial={{ name: "feature/{{ $json.ticket }}", from: "main", checkout: true }}
    />
  ),
}

// ocr.extract — URL source with markdown output.
export const OcrFromUrl: Story = {
  render: () => (
    <Controlled
      Form={OcrExtractConfig}
      initial={{
        screen: false,
        url: "https://example.com/invoice.pdf",
        languages: ["en", "zh"],
        format: "markdown",
      }}
    />
  ),
}

// ocr.extract — "screen" mode hides the image-source fields entirely.
export const OcrFromScreen: Story = {
  render: () => <Controlled Form={OcrExtractConfig} initial={{ screen: true, format: "text" }} />,
}
