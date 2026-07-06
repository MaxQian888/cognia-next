import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetEyesGroup, PetMouth } from "./pet-face"

// Face primitives: eyes (6 shapes) and mouth (7 shapes), drawn at fixed
// coordinates in the 100×100 pet viewBox. Stories wrap them in a sized <svg>.
const meta = {
  title: "Pet/Skins/Face",
  component: PetEyesGroup,
  parameters: { layout: "centered" },
  args: { kind: "dot" },
  decorators: [
    (Story) => (
      <svg viewBox="20 35 60 45" width={200} height={150} style={{ overflow: "visible" }}>
        <Story />
      </svg>
    ),
  ],
} satisfies Meta<typeof PetEyesGroup>

export default meta
type Story = StoryObj<typeof meta>

export const EyesDot: Story = {}
export const EyesWide: Story = { args: { kind: "wide" } }
export const EyesSleepy: Story = { args: { kind: "sleepy" } }
export const EyesWink: Story = { args: { kind: "wink" } }
export const EyesStar: Story = { args: { kind: "star" } }
export const EyesSpiral: Story = { args: { kind: "spiral" } }

export const MouthSmile: Story = {
  render: () => <PetMouth shape="smile" />,
}
export const MouthGrin: Story = {
  render: () => <PetMouth shape="grin" />,
}
export const MouthFrown: Story = {
  render: () => <PetMouth shape="frown" />,
}
export const MouthOpen: Story = {
  render: () => <PetMouth shape="open" />,
}
