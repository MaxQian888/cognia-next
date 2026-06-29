import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIAnalysisAdapter } from "./a2ui-analysis-adapter"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIComponent } from "@/types/a2ui/schema"

const component: A2UIComponent = { id: "analysis", component: "AcademicAnalysis" }

// The adapter reads paper/analysis state from the A2UI data model and renders
// AcademicAnalysisPanel, forwarding interactions back as A2UI actions.
const meta = {
  title: "A2UI/Academic/AnalysisAdapter",
  component: A2UIAnalysisAdapter,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[520px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UIAnalysisAdapter>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(component, {
    dataModel: {
      paperTitle: "Attention Is All You Need",
      paperAbstract: "A model architecture relying entirely on attention mechanisms.",
      analysisType: "key-insights",
      analysisContent:
        "The Transformer replaces recurrence with self-attention, enabling far greater parallelization during training.",
      suggestedQuestions: ["How is positional information encoded?"],
      relatedTopics: ["Self-attention", "Positional encoding"],
    },
    onAction: fn(),
    onDataChange: fn(),
  }),
}

export const Loading: Story = {
  args: makeA2UIProps(component, {
    dataModel: { paperTitle: "Loading paper…", isLoading: true },
    onAction: fn(),
    onDataChange: fn(),
  }),
}
