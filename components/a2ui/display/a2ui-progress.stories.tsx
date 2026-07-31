import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"

import { A2UIProgress } from "./a2ui-progress"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIProgressComponent } from "@/types/a2ui/schema"

const progress = (over: Partial<A2UIProgressComponent> = {}): A2UIProgressComponent => ({
  id: "progress",
  component: "Progress",
  value: 50,
  ...over,
})

// A2UIProgress resolves value/label through the A2UI data context.
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <div style={{ width: 320 }}>
      <Story />
    </div>
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/Progress",
  component: A2UIProgress,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIProgress>

export default meta
type Story = StoryObj<typeof meta>

export const Half: Story = { args: makeA2UIProps(progress({ value: 50 })) }

export const Empty: Story = { args: makeA2UIProps(progress({ value: 0 })) }

export const Full: Story = { args: makeA2UIProps(progress({ value: 100 })) }

export const WithLabel: Story = {
  args: makeA2UIProps(progress({ value: 72, label: "Uploading files" })),
}

export const WithValue: Story = {
  args: makeA2UIProps(progress({ value: 30, label: "Indexing", showValue: true })),
}

export const CustomMax: Story = {
  args: makeA2UIProps(progress({ value: 3, max: 5, label: "Step", showValue: true })),
}
