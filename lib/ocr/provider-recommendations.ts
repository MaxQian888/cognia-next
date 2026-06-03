/**
 * Use-case → provider preset map for the OCR setup wizard.
 *
 * The wizard asks "what do you want to OCR?" and uses this table to suggest a
 * starter configuration. We intentionally pick 2-3 providers per use-case so
 * the user has options without being overwhelmed; the first id is the
 * recommended default and lands in `defaultProviderId`.
 */

import { OCR_PROVIDER_CAPABILITIES } from "./capabilities"
import type { OcrOutputFormat } from "@/types/ocr"

export type OcrUseCase =
  | "chineseReceipts"
  | "handwriting"
  | "formulas"
  | "scannedContracts"
  | "webScreenshots"
  | "mixed"

export interface OcrUseCasePreset {
  /** Recommended providers, head of list = default. */
  providers: readonly string[]
  defaultLanguages: readonly string[]
  defaultFormat: OcrOutputFormat
  /** When true, the recommendation skews toward LLM-vision providers. */
  prefersLlmVision: boolean
}

export const RECOMMENDATION_MAP: Record<OcrUseCase, OcrUseCasePreset> = {
  chineseReceipts: {
    providers: ["paddle-ocr", "lark-basic", "mistral-ocr"],
    defaultLanguages: ["zh", "en"],
    defaultFormat: "markdown",
    prefersLlmVision: false,
  },
  handwriting: {
    providers: ["google-vision", "azure-document-intelligence", "anthropic-vision"],
    defaultLanguages: ["en"],
    defaultFormat: "markdown",
    prefersLlmVision: false,
  },
  formulas: {
    providers: ["mathpix", "anthropic-vision", "gemini-vision"],
    defaultLanguages: ["en"],
    defaultFormat: "markdown",
    prefersLlmVision: true,
  },
  scannedContracts: {
    providers: ["azure-document-intelligence", "aws-textract", "abbyy-cloud"],
    defaultLanguages: ["en"],
    defaultFormat: "blocks",
    prefersLlmVision: false,
  },
  webScreenshots: {
    providers: ["mistral-ocr", "gemini-vision", "apple-vision"],
    defaultLanguages: ["en"],
    defaultFormat: "markdown",
    prefersLlmVision: true,
  },
  mixed: {
    providers: ["mistral-ocr", "tesseract-wasm", "anthropic-vision"],
    defaultLanguages: ["en"],
    defaultFormat: "markdown",
    prefersLlmVision: false,
  },
}

export const OCR_USE_CASES: readonly OcrUseCase[] = Object.keys(
  RECOMMENDATION_MAP
) as readonly OcrUseCase[]

/** Every recommended provider must have a capability row. */
export function validateRecommendationMap(): void {
  for (const [useCase, preset] of Object.entries(RECOMMENDATION_MAP)) {
    if (preset.providers.length === 0) {
      throw new Error(`Use-case ${useCase} has no recommended providers`)
    }
    for (const providerId of preset.providers) {
      if (!OCR_PROVIDER_CAPABILITIES[providerId]) {
        throw new Error(
          `Use-case ${useCase} recommends unknown provider ${providerId} (missing from capabilities.ts)`
        )
      }
    }
  }
}
