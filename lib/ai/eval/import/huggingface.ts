/**
 * Import a HuggingFace dataset via the public datasets-server rows API. Accepts
 * an `hf://datasets/<owner>/<name>?config=&split=` URI (or the bare
 * `owner/name`). Rows are mapped to cases via a {@link FieldSpec}. `fetchImpl`
 * is injected for testability and to keep this offline-degradable (the UI
 * disables the HF tab when offline).
 */

import type { FieldSpec, ImportPreview, ParsedRows } from "@/types/eval/import"
import type { MappingDeps } from "./field-mapping"
import { mapRowsToCases } from "./field-mapping"

const ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows"

export interface HuggingFaceRef {
  dataset: string
  config: string
  split: string
}

/** Parse an `hf://datasets/owner/name?config=&split=` URI (or `owner/name`). */
export function parseHuggingFaceUri(uri: string): HuggingFaceRef {
  const trimmed = uri.trim()
  let path = trimmed
  let query = ""
  const qIdx = trimmed.indexOf("?")
  if (qIdx >= 0) {
    path = trimmed.slice(0, qIdx)
    query = trimmed.slice(qIdx + 1)
  }
  path = path.replace(/^hf:\/\//i, "").replace(/^datasets\//i, "")
  const params = new URLSearchParams(query)
  const dataset = path.replace(/\/+$/, "")
  if (!dataset) throw new Error("parseHuggingFaceUri: missing dataset (owner/name)")
  return {
    dataset,
    config: params.get("config") ?? "default",
    split: params.get("split") ?? "train",
  }
}

export async function importHuggingFace(
  uri: string,
  spec: FieldSpec,
  deps: MappingDeps,
  options: { length?: number; fetchImpl?: typeof fetch } = {}
): Promise<ImportPreview> {
  const ref = parseHuggingFaceUri(uri)
  const length = Math.min(Math.max(1, options.length ?? 100), 100)
  const fetchImpl = options.fetchImpl ?? fetch
  const url =
    `${ROWS_ENDPOINT}?dataset=${encodeURIComponent(ref.dataset)}` +
    `&config=${encodeURIComponent(ref.config)}&split=${encodeURIComponent(ref.split)}` +
    `&offset=0&length=${length}`
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`HuggingFace import failed: HTTP ${res.status}`)
  const body = (await res.json()) as { rows?: Array<{ row?: Record<string, unknown> }> }
  const rawRows = Array.isArray(body.rows)
    ? body.rows
        .map((r) => r.row)
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    : []
  const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : []
  const parsed: ParsedRows = { columns, rows: rawRows }
  return mapRowsToCases(parsed, spec, deps)
}
