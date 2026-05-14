/**
 * eml importer — RFC-5322 single-message parser. Wraps the same logic as
 * `mbox.ts:parseMbox` but for a one-off `.eml` file (no boundary splitter).
 */

import type { RawSource } from "@/lib/twin/ingest/parse"
import { parseMbox } from "./mbox"

export interface EmlImportOptions {
  twinId: string
  source?: string
}

export function parseEml(content: string, options: EmlImportOptions): RawSource[] {
  // Reuse the mbox parser by prepending a synthetic "From " marker — this
  // keeps the header / body split + markdown formatting logic in one place.
  const synthetic = `From local@example 0\n${content}`
  return parseMbox(synthetic, options).map((src, i) => ({
    ...src,
    id: src.id.replace("_mbox_", "_eml_"),
    filename: `${options.source ?? "eml-message"}-${i + 1}.md`,
  }))
}
