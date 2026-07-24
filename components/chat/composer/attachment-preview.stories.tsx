import { useEffect, useRef } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AttachmentPreview } from "./attachment-preview"
import { StagedAttachmentsProvider } from "./staged-attachment-store"
import {
  PromptInputProvider,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"

// The chips render from the PromptInput attachments context, so we seed it
// through its public `add(File[])` API. `StagedAttachmentsProvider` then runs
// the same staging-time extraction the composer does, which is what produces
// the token badges and the preview panel's "model view".
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
        <StagedAttachmentsProvider>
          <Seeder files={files} />
          <div className="w-full max-w-2xl">
            <Story />
          </div>
        </StagedAttachmentsProvider>
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

// Mixed media at one uniform chip height — the case that used to blow the bar
// up to 80px because images rendered as squares next to 28px text chips.
export const ImageAndDocument: Story = {
  decorators: [
    withFiles([
      pngFile("screenshot.png"),
      pngFile("diagram.png"),
      textFile("notes.md", "# Notes\nhello"),
    ]),
  ],
}

// A document long enough to carry a visible token badge; clicking the chip
// opens the preview panel with the File / Model view tabs.
export const WithTokenBadge: Story = {
  decorators: [
    withFiles([textFile("report.md", "# Report\n\n" + "lorem ipsum dolor sit amet. ".repeat(200))]),
  ],
}

// With the OCR handlers wired, an image's "model view" grows the OCR layer and
// its explicit "also send OCR text" opt-in.
export const WithOcrHandlers: Story = {
  args: { onRunOcr: fn(), onExtractOcrToInput: fn(), onViewOcrDetail: fn() },
  decorators: [withFiles([pngFile("receipt.png"), textFile("data.csv", "a,b\n1,2")])],
}
