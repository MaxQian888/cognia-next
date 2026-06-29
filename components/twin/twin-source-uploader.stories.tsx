import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TwinSourceUploader } from "./twin-source-uploader"

// Props-driven uploader (twinId + onUploaded callback). The drop zone + format
// controls render without any DB rows; ingestion only runs once files are
// added, and `onUploaded` is a spy.
const meta = {
  title: "Twin/SourceUploader",
  component: TwinSourceUploader,
  parameters: { layout: "padded" },
  args: { twinId: "twin-1", onUploaded: fn() },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinSourceUploader>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
