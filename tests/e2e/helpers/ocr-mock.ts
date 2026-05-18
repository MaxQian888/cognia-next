/**
 * Helper for OCR specs that drive `lib/ocr/extract()` without depending on
 * real cloud keys or native binaries. Installs / clears the
 * `window.__cogniaE2EOcrMock` short-circuit consumed by the entry function.
 */

import { type Page } from "@playwright/test"
import { waitForTestGlobals } from "./db-reset"

export interface MockOcrPageResult {
  pageNumber: number
  text: string
  markdown: string
}

export interface MockOcrResult {
  providerId: string
  pages: MockOcrPageResult[]
  combinedMarkdown: string
  combinedText: string
  languages: string[]
  durationMs: number
  cached: boolean
}

export interface OcrMockBehavior {
  kind: "success"
  result: MockOcrResult
}

export interface OcrMockError {
  kind: "error"
  code: "provider_failed" | "credentials_missing" | "invalid_input" | "aborted"
  message: string
}

export type OcrMockSpec = OcrMockBehavior | OcrMockError

const DEFAULT_RESULT: MockOcrResult = {
  providerId: "e2e-mock",
  pages: [
    {
      pageNumber: 1,
      text: "hello e2e ocr",
      markdown: "hello e2e ocr",
    },
  ],
  combinedMarkdown: "hello e2e ocr",
  combinedText: "hello e2e ocr",
  languages: ["en"],
  durationMs: 5,
  cached: false,
}

export async function installOcrMock(
  page: Page,
  spec: OcrMockSpec = { kind: "success", result: DEFAULT_RESULT }
): Promise<void> {
  await waitForTestGlobals(page)
  await page.evaluate((s) => {
    const w = window as {
      __cogniaE2EOcrMock?: (input: unknown) => unknown
    }
    if (s.kind === "success") {
      const fixed = s.result
      w.__cogniaE2EOcrMock = () => fixed
    } else {
      const e = s
      w.__cogniaE2EOcrMock = () => {
        const err = Object.assign(new Error(e.message), {
          name: "OcrError",
          code: e.code,
          providerId: "e2e-mock",
        })
        throw err
      }
    }
  }, spec)
}

export async function clearOcrMock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as { __cogniaE2EOcrMock?: unknown }
    delete w.__cogniaE2EOcrMock
  })
}
