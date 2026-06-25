import { useEffect, useRef } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AttachmentPreview } from "./attachment-preview"
import {
  PromptInputProvider,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"

// AttachmentPreview returns null with zero files, so we seed the PromptInput
// attachments context through its public `add(File[])` API. A 1x1 PNG (decoded
// from base64) and a couple of plain-text files give us one image thumb and two
// file chips — the component's two render branches.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

function pngFile(name: string): File {
  const bytes = Uint8Array.from(atob(PNG_1x1), (c) => c.charCodeAt(0))
  return new File([bytes], name, { type: "image/png" })
}

function textFile(name: string, body: string): File {
  return new File([body], name, { type: "text/plain" })
}

/** Pushes a fixed set of files into the attachments context once on mount. */
function Seeder({ files }: { files: File[] }) {
  const attachments = usePromptInputAttachments()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    attachments.add(files)
  }, [attachments, files])
  return null
}

function withFiles(files: File[]) {
  return function Decorator(Story: () => React.ReactElement) {
    return (
      <PromptInputProvider>
        <Seeder files={files} />
        <div className="w-full max-w-2xl">
          <Story />
        </div>
      </PromptInputProvider>
    )
  }
}

const meta = {
  title: "Chat/Composer/AttachmentPreview",
  component: AttachmentPreview,
  parameters: { layout: "padded" },
} satisfies Meta<typeof AttachmentPreview>

export default meta
type Story = StoryObj<typeof meta>

// One image thumb + one file chip, each with a hover-only remove button.
export const ImageAndFile: Story = {
  decorators: [withFiles([pngFile("screenshot.png"), textFile("notes.md", "# Notes\nhello")])],
}

// With an `onOcrSelect` handler, OCR-eligible attachments (the image) grow a
// hover-only OCR menu next to the remove button.
export const WithOcrMenu: Story = {
  args: { onOcrSelect: fn() },
  decorators: [withFiles([pngFile("receipt.png"), textFile("data.csv", "a,b\n1,2")])],
}
