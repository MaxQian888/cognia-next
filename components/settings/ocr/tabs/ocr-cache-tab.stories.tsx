import type { Meta, StoryObj } from "@storybook/nextjs"

import { OcrCacheTab } from "./ocr-cache-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeOcrCacheRow } from "@/lib/storybook/fixtures/settings-ocr-tabs"

// Dexie-backed: reads the `ocrResults` table via `useLiveQuery`. The Empty
// story relies on a fresh (empty) IndexedDB; the populated stories seed rows in
// an async `beforeEach`.
const meta = {
  title: "Settings/Ocr/Tabs/OcrCacheTab",
  component: OcrCacheTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof OcrCacheTab>

export default meta
type Story = StoryObj<typeof meta>

// No cached rows — renders the empty placeholder and disabled "clear all".
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

// A handful of cached results across multiple providers populates the table,
// the totals badges, and the provider filter dropdown.
export const WithRows: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.ocrResults.bulkPut([
        makeOcrCacheRow({ id: "row-1", providerId: "mistral-ocr", langs: "en", bytesIn: 240_000 }),
        makeOcrCacheRow({
          id: "row-2",
          providerId: "mistral-ocr",
          langs: "en,zh",
          bytesIn: 512_000,
          createdAt: Date.now() - 86_400_000 * 2,
        }),
        makeOcrCacheRow({
          id: "row-3",
          providerId: "tesseract-wasm",
          langs: "",
          bytesIn: 96_000,
          createdAt: Date.now() - 120_000,
        }),
      ])
    })
  },
}
