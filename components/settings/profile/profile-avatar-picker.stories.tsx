import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { ProfileAvatarPicker } from "./profile-avatar-picker"

// Pure props component: an avatar badge + upload/clear buttons. Picking a file
// opens the crop dialog (not exercised here). The stories use local state so
// the Clear button toggles the badge between an image and the glyph fallback.
function Harness({ initial }: { initial: string | null }) {
  const [value, setValue] = useState<string | null>(initial)
  return <ProfileAvatarPicker value={value} fallbackName="Ada Lovelace" onChange={setValue} />
}

const meta = {
  title: "Settings/Profile/ProfileAvatarPicker",
  component: ProfileAvatarPicker,
  parameters: { layout: "padded" },
  args: { fallbackName: "Ada Lovelace", value: null, onChange: fn() },
} satisfies Meta<typeof ProfileAvatarPicker>

export default meta
type Story = StoryObj<typeof meta>

// No avatar → initials glyph fallback, only the upload button.
export const NoAvatar: Story = {
  render: () => <Harness initial={null} />,
}

// With an avatar set → the image renders and a Clear button appears.
export const WithAvatar: Story = {
  render: () => (
    <Harness initial="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjN2M0ZGZmIi8+PC9zdmc+" />
  ),
}

// Disabled state — buttons inert.
export const Disabled: Story = {
  args: { disabled: true, value: null },
}
