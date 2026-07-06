import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinProfilePanel } from "./twin-profile-panel"

// Quick read of the bound twin's distilled state. It fetches the raw profile
// row through the `twin_profile_get` companion RPC on mount. In Storybook
// there is no paired desktop, so the transport rejects and the panel settles
// on its friendly load-failure state — exactly what a phone with no companion
// shows. (Loading → error transition is the documented behaviour here.)
const meta = {
  title: "Mobile/Discover/TwinProfilePanel",
  component: TwinProfilePanel,
  parameters: { layout: "padded" },
  args: { twinId: "default" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinProfilePanel>

export default meta
type Story = StoryObj<typeof meta>

export const NoCompanion: Story = {}
