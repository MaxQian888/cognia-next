/**
 * Import a HuggingFace dataset via the public datasets-server API.
 *
 * Accepts an `hf://datasets/<owner>/<name>?config=&split=` URI (or the bare
 * `owner/name`). `fetchImpl` is injected for testability and to keep this
 * offline-degradable (the UI disables the HF tab when offline).
 *
 * Two things this has to get right to be usable on a REAL test set:
 *
 *  - **Pagination.** The rows endpoint caps a request at 100 rows, and the
 *    importer used to stop there — so "import GSM8K's test split" silently
 *    meant "import the first 100 of 1319". {@link importHuggingFace} now loops
 *    until it has `limit` rows or the server runs out, reporting progress and
 *    honouring an abort between pages.
 *  - **The split.** `parseHuggingFaceUri` always knew the split and then threw
 *    it away, so every imported case had `split: undefined` and the run
 *    dialog's split filter could never match one. It is now carried through as
 *    `FieldSpec.splitLiteral`.
 *
 * {@link fetchHuggingFaceSchema} exists so the UI can offer real config/split
 * choices and real column names instead of asking the user to guess a URI and
 * hardcoding `question`/`answer` — which is why every dataset that did not
 * happen to use those two column names imported zero rows without an error.
 */

import type { FieldSpec, ImportPreview, ParsedRows } from "@/types/eval/import"
import type { MappingDeps } from "./field-mapping"
import { mapRowsToCases } from "./field-mapping"

const ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows"
const SPLITS_ENDPOINT = "https://datasets-server.huggingface.co/splits"

/** The rows endpoint's hard per-request cap. */
const PAGE_SIZE = 100

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

export interface HuggingFaceSchema {
  /** Every `(config, split)` pair the dataset publishes. */
  splits: { config: string; split: string }[]
  /** Column names of the first page of the requested (or first) split. */
  columns: string[]
  /** A few real rows, so the mapping UI can preview what a rule would extract. */
  sampleRows: Record<string, unknown>[]
  /** The ref the sample rows came from. */
  ref: HuggingFaceRef
}

interface RowsBody {
  rows?: Array<{ row?: Record<string, unknown> }>
  num_rows_total?: number
}

async function fetchRowsPage(
  ref: HuggingFaceRef,
  offset: number,
  length: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<{ rows: Record<string, unknown>[]; total?: number }> {
  const url =
    `${ROWS_ENDPOINT}?dataset=${encodeURIComponent(ref.dataset)}` +
    `&config=${encodeURIComponent(ref.config)}&split=${encodeURIComponent(ref.split)}` +
    `&offset=${offset}&length=${length}`
  const res = await fetchImpl(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`HuggingFace import failed: HTTP ${res.status}`)
  const body = (await res.json()) as RowsBody
  const rows = Array.isArray(body.rows)
    ? body.rows
        .map((r) => r.row)
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    : []
  return {
    rows,
    ...(typeof body.num_rows_total === "number" ? { total: body.num_rows_total } : {}),
  }
}

/**
 * Discover a dataset's configs/splits and the columns of one of them, so the
 * import wizard can present real choices instead of a free-text URI.
 */
export async function fetchHuggingFaceSchema(
  uri: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<HuggingFaceSchema> {
  const requested = parseHuggingFaceUri(uri)
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${SPLITS_ENDPOINT}?dataset=${encodeURIComponent(requested.dataset)}`
  const res = await fetchImpl(url, options.signal ? { signal: options.signal } : {})
  if (!res.ok) throw new Error(`HuggingFace schema lookup failed: HTTP ${res.status}`)
  const body = (await res.json()) as { splits?: { config?: unknown; split?: unknown }[] }
  const splits = (Array.isArray(body.splits) ? body.splits : [])
    .filter((s) => typeof s.config === "string" && typeof s.split === "string")
    .map((s) => ({ config: s.config as string, split: s.split as string }))

  // Honour the requested config/split when the dataset actually has it;
  // otherwise fall back to the first one it publishes, so a bare `owner/name`
  // (which defaults to `default`/`train`) still previews something.
  const hit = splits.find((s) => s.config === requested.config && s.split === requested.split)
  const chosen = hit ?? splits[0]
  const ref: HuggingFaceRef = chosen
    ? { dataset: requested.dataset, config: chosen.config, split: chosen.split }
    : requested

  const { rows } = await fetchRowsPage(ref, 0, 5, fetchImpl, options.signal)
  return {
    splits,
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    sampleRows: rows,
    ref,
  }
}

export interface HuggingFaceImportOptions {
  /** How many rows to pull in total. Paged internally. Default 100. */
  limit?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Fired after each page lands, for a progress bar on a long import. */
  onProgress?: (fetched: number, total?: number) => void
}

export async function importHuggingFace(
  uri: string,
  spec: FieldSpec,
  deps: MappingDeps,
  options: HuggingFaceImportOptions = {}
): Promise<ImportPreview> {
  const ref = parseHuggingFaceUri(uri)
  const limit = Math.max(1, Math.floor(options.limit ?? PAGE_SIZE))
  const fetchImpl = options.fetchImpl ?? fetch

  const rawRows: Record<string, unknown>[] = []
  let total: number | undefined
  while (rawRows.length < limit) {
    if (options.signal?.aborted) break
    const want = Math.min(PAGE_SIZE, limit - rawRows.length)
    const page = await fetchRowsPage(ref, rawRows.length, want, fetchImpl, options.signal)
    if (page.total !== undefined) total = page.total
    rawRows.push(...page.rows)
    options.onProgress?.(rawRows.length, total)
    // A short page means the split is exhausted — stop rather than spin.
    if (page.rows.length < want) break
  }

  const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : []
  const parsed: ParsedRows = { columns, rows: rawRows }
  // The URI names the split; carry it onto every case unless the caller mapped
  // a split column explicitly.
  const withSplit: FieldSpec = {
    ...spec,
    ...(spec.split || spec.splitLiteral ? {} : { splitLiteral: ref.split }),
    sourceKind: spec.sourceKind ?? "synthetic",
  }
  return mapRowsToCases(parsed, withSplit, deps)
}
