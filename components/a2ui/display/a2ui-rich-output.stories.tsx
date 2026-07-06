import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIRichOutput } from "./a2ui-rich-output"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type {
  A2UIRichOutputComponent,
  A2UIRichOutputItem,
  A2UIRichOutputStep,
} from "@/types/a2ui/schema"

const richOutput = (over: Partial<A2UIRichOutputComponent> = {}): A2UIRichOutputComponent => ({
  id: "rich-output",
  component: "RichOutput",
  profileId: "quick-factual-answer",
  ...over,
})

const meta = {
  title: "A2UI/Display/RichOutput",
  component: A2UIRichOutput,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIRichOutput>

export default meta
type Story = StoryObj<typeof meta>

export const PlainText: Story = {
  args: makeA2UIProps(
    richOutput({
      profileId: "quick-factual-answer",
      title: "Answer",
      content:
        "The Eiffel Tower is 330 metres tall, including its antennas, making it one of the tallest structures in Paris.",
    })
  ),
}

const KPI_ITEMS: A2UIRichOutputItem[] = [
  { id: "mrr", title: "MRR", value: "$48.2k", description: "+12% MoM", badge: "Up" },
  { id: "churn", title: "Churn", value: "1.8%", description: "-0.3pt", badge: "Good" },
  { id: "nps", title: "NPS", value: "62", description: "+5", badge: "Healthy" },
]

export const KpiMetrics: Story = {
  args: makeA2UIProps(
    richOutput({
      profileId: "kpis-metrics",
      title: "Q2 snapshot",
      description: "Key SaaS metrics for the quarter.",
      items: KPI_ITEMS,
    })
  ),
}

const STEPS: A2UIRichOutputStep[] = [
  { id: "plan", title: "Plan", description: "Define the goal", body: "Scope the work" },
  { id: "build", title: "Build", description: "Implement", body: "Write the code" },
  { id: "review", title: "Review", description: "Verify", body: "Check the output" },
]

export const CyclicProcess: Story = {
  args: makeA2UIProps(
    richOutput({
      profileId: "cyclic-process",
      title: "Delivery loop",
      description: "Iterate through each phase.",
      steps: STEPS,
      currentStep: 1,
    })
  ),
}

export const DataTable: Story = {
  args: makeA2UIProps(
    richOutput({
      profileId: "data-exploration",
      title: "Top regions",
      tableColumns: [
        { key: "region", label: "Region" },
        { key: "users", label: "Users", numeric: true },
      ],
      tableRows: [
        { region: "North America", users: 12400 },
        { region: "Europe", users: 9800 },
        { region: "Asia Pacific", users: 7600 },
      ],
    })
  ),
}

export const Fallback: Story = {
  args: makeA2UIProps(
    richOutput({
      profileId: "quick-factual-answer",
      title: "No content",
      fallbackContent: "We could not generate a rich answer for this request.",
    })
  ),
}
