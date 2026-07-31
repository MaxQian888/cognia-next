import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WallpaperUploader } from "./wallpaper-uploader"

// Drag-and-drop / click dropzone for image wallpapers. Decodes the picked file
// to an `UploadedWallpaper` (bytes + mime + dimensions) and hands it to
// `onUpload`. `disabled` greys out the dropzone.
const meta = {
  title: "Settings/Appearance/WallpaperUploader",
  component: WallpaperUploader,
  parameters: { layout: "padded" },
  args: { onUpload: fn() },
} satisfies Meta<typeof WallpaperUploader>

export default meta
type Story = StoryObj<typeof meta>

// Active dropzone.
export const Default: Story = {}

// Disabled (e.g. a save is in flight elsewhere).
export const Disabled: Story = {
  args: { disabled: true },
}
