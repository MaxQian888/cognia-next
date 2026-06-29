import type { Meta, StoryObj } from "@storybook/nextjs"

import { ManifestValidator } from "./manifest-validator"

// Paste-a-manifest validator for the devtools pane — the author pastes
// `plugin.json` into the textarea and gets schema validation feedback inline.
// Fully client-side, so it works in Storybook; the story renders the empty
// editor ready for input.

const meta = {
  title: "Plugins/Devtools/ManifestValidator",
  component: ManifestValidator,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ManifestValidator>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
