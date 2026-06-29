import type { Meta, StoryObj } from "@storybook/nextjs"
import { useMemo } from "react"
import { fn } from "storybook/test"

import { AvatarEditDialog } from "./avatar-edit-dialog"

// Crop/zoom editor shown after a file is picked. `file === null` keeps the
// dialog closed; a non-null File opens it and loads the image into the square
// crop viewport with pan + zoom controls.

// A tiny solid-color PNG decoded into a File so the crop editor has a real
// image to load inside Storybook's browser.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

function pngFile(): File {
  const bytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0))
  return new File([bytes], "avatar.png", { type: "image/png" })
}

function OpenHarness() {
  const file = useMemo(() => pngFile(), [])
  return <AvatarEditDialog file={file} onCancel={fn()} onConfirm={fn()} />
}

const meta = {
  title: "Settings/Profile/AvatarEditDialog",
  component: AvatarEditDialog,
  parameters: { layout: "centered" },
  args: { file: null, onCancel: fn(), onConfirm: fn() },
} satisfies Meta<typeof AvatarEditDialog>

export default meta
type Story = StoryObj<typeof meta>

// Closed: file is null, nothing rendered.
export const Closed: Story = {}

// Open: a picked PNG drives the crop viewport with zoom + confirm/cancel.
export const Open: Story = {
  render: () => <OpenHarness />,
}
