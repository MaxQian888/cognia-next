import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ErrorHandlingSection } from "./error-handling-section"
import type { WorkflowNodeErrorHandling } from "@/types/workflow/visual"

// Collapsible per-node "Error handling" section. It owns the open/close + JSON
// draft state internally; the controlled wrapper just holds the committed
// `errorHandling` value (which normalizes an all-defaults config back to
// `undefined`).
function Controlled({ initial }: { initial?: WorkflowNodeErrorHandling }) {
  const [value, setValue] = React.useState<WorkflowNodeErrorHandling | undefined>(initial)
  return (
    <div className="w-[360px]">
      <ErrorHandlingSection errorHandling={value} onChange={setValue} />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/Shared/ErrorHandlingSection",
  component: ErrorHandlingSection,
  parameters: { layout: "padded" },
  args: { errorHandling: undefined, onChange: fn() },
} satisfies Meta<typeof ErrorHandlingSection>

export default meta
type Story = StoryObj<typeof meta>

// No config — collapsed, no "configured" badge.
export const Unconfigured: Story = {
  render: () => <Controlled />,
}

// Continue-on-error with a retry override (expanded, shows retry grid).
export const WithRetry: Story = {
  render: () => (
    <Controlled
      initial={{
        onError: "continue",
        retry: {
          maxRetries: 3,
          retryIntervalMs: 1000,
          backoff: "exponential",
          maxIntervalMs: 8000,
        },
      }}
    />
  ),
}

// Default-value fallback — reveals the JSON textarea.
export const DefaultValueFallback: Story = {
  render: () => (
    <Controlled initial={{ onError: "defaultValue", defaultValue: { completion: "fallback" } }} />
  ),
}

// Circuit breaker enabled alongside an error branch.
export const WithCircuitBreaker: Story = {
  render: () => (
    <Controlled
      initial={{ onError: "errorBranch", circuitBreaker: { threshold: 5, cooldownMs: 60_000 } }}
    />
  ),
}
