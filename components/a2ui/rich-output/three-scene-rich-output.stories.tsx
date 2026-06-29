import type { Meta, StoryObj } from "@storybook/nextjs"

import { ThreeSceneRichOutput } from "./three-scene-rich-output"

// react-three-fiber WebGL scene with a rotating torus knot.
const meta = {
  title: "A2UI/RichOutput/ThreeScene",
  component: ThreeSceneRichOutput,
  parameters: { layout: "centered" },
  args: { prompt: "A rotating torus knot" },
  decorators: [
    (Story) => (
      <div className="h-[360px] w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ThreeSceneRichOutput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NoPrompt: Story = { args: { prompt: undefined } }
