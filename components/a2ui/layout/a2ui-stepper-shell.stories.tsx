import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIStepperShell } from "./a2ui-stepper-shell"
import type { A2UIStepperShellComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const STEPS = [
  {
    id: "connect",
    title: "Connect a source",
    description: "Link the repository or data source you want to analyze.",
    body: "Cognia supports GitHub, GitLab, and local folders.",
  },
  {
    id: "configure",
    title: "Configure the run",
    description: "Pick a model and effort level.",
    body: "Defaults are tuned for balanced speed and quality.",
  },
  {
    id: "review",
    title: "Review results",
    description: "Inspect the generated report before sharing.",
    body: "Every claim links back to its source.",
  },
]

const stepper = (over: Partial<A2UIStepperShellComponent> = {}): A2UIStepperShellComponent => ({
  id: "stepper",
  component: "StepperShell",
  title: "Getting started",
  description: "Three steps to your first run",
  steps: STEPS,
  ...over,
})

const meta = {
  title: "A2UI/Layout/StepperShell",
  component: A2UIStepperShell,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIStepperShell>

export default meta
type Story = StoryObj<typeof meta>

export const FirstStep: Story = { args: makeA2UIProps(stepper({ currentStep: 0 })) }

export const MiddleStep: Story = { args: makeA2UIProps(stepper({ currentStep: 1 })) }

export const LastStep: Story = { args: makeA2UIProps(stepper({ currentStep: 2 })) }

export const Empty: Story = { args: makeA2UIProps(stepper({ steps: [] })) }
