import type { Meta, StoryObj } from "@storybook/nextjs"

import { JupyterRenderer } from "./jupyter-renderer"
import { NOTEBOOK_JSON } from "@/lib/storybook/fixtures/artifacts"

// Lightweight `.ipynb` cell + output renderer. Takes the raw notebook JSON as
// `content`; invalid JSON falls back to the parse-error state.
const meta = {
  title: "Artifacts/JupyterRenderer",
  component: JupyterRenderer,
  args: { content: NOTEBOOK_JSON },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-full flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof JupyterRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const Notebook: Story = {}

export const ParseError: Story = {
  args: { content: "{ not valid json" },
}
