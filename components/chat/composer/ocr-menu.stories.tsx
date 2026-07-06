import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrMenu } from "./ocr-menu"

// Dropdown menu rendered next to image/PDF attachments. Two actions: extract
// text to the composer input, or view the extracted text in a side sheet.
// Renders nothing when the attachment media type is not OCR-eligible.
const meta = {
  title: "Chat/Composer/OcrMenu",
  component: OcrMenu,
  parameters: { layout: "centered" },
  args: {
    attachmentId: "att-1",
    mediaType: "image/png",
    onSelect: fn(),
  },
} satisfies Meta<typeof OcrMenu>

export default meta
type Story = StoryObj<typeof meta>

/** An image attachment — the OCR trigger is shown. Open the menu. */
export const ImageAttachment: Story = {}

/** A PDF attachment is also OCR-eligible. */
export const PdfAttachment: Story = {
  args: { mediaType: "application/pdf" },
}

/** Disabled while an OCR call is in flight. */
export const Disabled: Story = {
  args: { disabled: true },
}

/** A non-eligible media type → the menu renders nothing. */
export const NotEligible: Story = {
  args: { mediaType: "text/plain" },
}
