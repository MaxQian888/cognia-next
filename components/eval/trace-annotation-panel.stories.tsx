import type { Meta, StoryObj } from "@storybook/nextjs"

import { TraceAnnotationPanel } from "./trace-annotation-panel"

// "Look at your data" flywheel — propless, driven by Dexie (recent traces,
// annotations, datasets). With an empty DB it renders the header, dataset
// picker, and the "no traces" empty state.
const meta = {
  title: "Eval/TraceAnnotationPanel",
  component: TraceAnnotationPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TraceAnnotationPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
