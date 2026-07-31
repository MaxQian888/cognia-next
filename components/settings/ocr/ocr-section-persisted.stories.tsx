import type { Meta, StoryObj } from "@storybook/nextjs"

import { OcrSectionPersisted } from "./ocr-section-persisted"

// Production wrapper around OcrSection: reads `ocrSettings` from the Dexie
// `appSettings` blob via useLiveQuery, loads stored credentials, and persists
// edits back. In the browser it renders against the fresh in-browser IndexedDB
// (DEFAULT_OCR_SETTINGS) with no stored credentials. No props.
const meta = {
  title: "Settings/Ocr/OcrSectionPersisted",
  component: OcrSectionPersisted,
  parameters: { layout: "padded" },
} satisfies Meta<typeof OcrSectionPersisted>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
