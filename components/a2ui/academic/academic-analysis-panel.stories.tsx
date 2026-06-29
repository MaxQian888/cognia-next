import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AcademicAnalysisPanel } from "./academic-analysis-panel"

const meta = {
  title: "A2UI/Academic/AnalysisPanel",
  component: AcademicAnalysisPanel,
  parameters: { layout: "fullscreen" },
  args: {
    paperTitle: "Attention Is All You Need",
    paperAbstract:
      "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
    analysisType: "summary",
    analysisContent:
      "This paper introduces the Transformer, a model architecture relying entirely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
    suggestedQuestions: [
      "How does multi-head attention work?",
      "What are the limitations of the Transformer?",
    ],
    relatedTopics: ["Self-attention", "Sequence modeling", "Machine translation"],
    onAnalysisTypeChange: fn(),
    onRegenerate: fn(),
    onAskFollowUp: fn(),
    onCopy: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[520px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AcademicAnalysisPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Loading: Story = { args: { isLoading: true } }

export const Minimal: Story = {
  args: { suggestedQuestions: [], relatedTopics: [], paperAbstract: undefined },
}
