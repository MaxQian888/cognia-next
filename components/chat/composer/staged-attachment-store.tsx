"use client"

/**
 * Derived state for the composer's staged attachments: extraction results,
 * user-defined order, and the OCR opt-in — everything the attachment chips and
 * the preview panel need that the vendored `PromptInputProvider` does not hold.
 *
 * Why a parallel owner instead of extending the provider: the provider lives in
 * `components/ai-elements/prompt-input.tsx`, which is vendored and must not be
 * edited. It also gives no way to learn the ids it generates — `add()` returns
 * void. So this store is written as a pure function OF the file list: it
 * observes `attachments.files`, extracts every id it has not seen, and drops
 * every id that disappeared. That makes it race-free under concurrent
 * pick/drop/paste, which a before/after diff around `add()` would not be.
 *
 * Extraction runs here, at staging time, so a chip can show a token count and
 * the preview panel can show what the model will actually receive — instead of
 * the user finding out only after they hit send. The results are handed back to
 * `buildSendContent` via `DispatchOptions.precomputed`, so nothing is parsed
 * twice.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import {
  extractAttachment,
  withImageOcrText,
  type ExtractedAttachment,
} from "@/lib/chat/attachments/dispatch"
import { applyOrder, reorderIds } from "@/lib/chat/attachments/reorder"
import { loggers } from "@cognia/logging"

export interface StagedAttachmentState {
  /** `extracting` until the parse settles; `rejected` carries `extracted.rejectReason`. */
  status: "extracting" | "ready" | "rejected"
  /** Byte size of the staged blob. Real, unlike the old data-URL estimate. */
  sizeBytes: number
  /**
   * The staged bytes, retained from the read extraction already performed. Kept
   * so persisting a draft costs no extra reads, and so a restored draft can
   * rebuild a `File` without the user re-attaching anything.
   */
  bytes?: Uint8Array
  /** Settled extraction. Absent while `status === "extracting"`. */
  extracted?: ExtractedAttachment
  /** Filled when the user runs OCR from the preview panel (images only). */
  ocrText?: string
  /** "Also send the OCR text alongside the image." Off by default. */
  includeOcr?: boolean
}

export interface StagedAttachmentsValue {
  byId: ReadonlyMap<string, StagedAttachmentState>
  /** Attachment ids in the user's chosen order. */
  order: readonly string[]
  /** True while any staged file is still being parsed. */
  isExtracting: boolean
  /** Summed blob size across staged files. */
  totalBytes: number
  /** Summed inline token cost of settled document extractions. */
  totalTokens: number
  /** Settled results keyed by id — feed straight to `DispatchOptions.precomputed`. */
  precomputed: ReadonlyMap<string, ExtractedAttachment>
  /** Resolves once no extraction is in flight. Awaited by submit. */
  whenSettled: () => Promise<void>
  /** Move `activeId` to `overId`'s slot (drag-and-drop reorder). */
  reorder: (activeId: string, overId: string) => void
  /** Record OCR text for an image and opt it into the outbound payload. */
  setOcrText: (id: string, text: string) => void
  toggleIncludeOcr: (id: string) => void
  /**
   * Pre-fill restored-draft extractions so re-staged files are not parsed a
   * second time.
   *
   * Keyed by filename + size rather than id because the vendored provider mints
   * ids internally and `add()` returns nothing — the caller cannot know what id
   * its restored file will get. Each entry is consumed by the first newly
   * observed file that matches it.
   */
  seedIncoming: (entries: readonly SeedEntry[]) => void
}

/** A restored draft attachment waiting to be matched to its re-staged file. */
export interface SeedEntry {
  filename: string
  sizeBytes: number
  state: StagedAttachmentState
}

const StagedAttachmentsContext = createContext<StagedAttachmentsValue | null>(null)

export function useStagedAttachments(): StagedAttachmentsValue {
  const ctx = useContext(StagedAttachmentsContext)
  if (!ctx) {
    throw new Error("useStagedAttachments must be used within <StagedAttachmentsProvider>")
  }
  return ctx
}

/**
 * Decode the base64 payload of a data URL to raw bytes.
 *
 * Derived from the data URL we already built rather than calling
 * `Blob.arrayBuffer()`: that avoids a second read of the same bytes, and
 * `atob` is available everywhere the composer runs (jsdom included).
 */
function dataUrlToBytes(dataUrl: string): Uint8Array | undefined {
  const comma = dataUrl.indexOf(",")
  if (comma < 0 || !dataUrl.slice(0, comma).includes(";base64")) return undefined
  const binary = atob(dataUrl.slice(comma + 1))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Read a staged blob URL back into a data URL, which is what extraction needs. */
async function blobUrlToDataUrl(
  url: string
): Promise<{ dataUrl: string; size: number; bytes: Uint8Array | undefined }> {
  const blob = await (await fetch(url)).blob()
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(blob)
  })
  return { dataUrl, size: blob.size, bytes: dataUrlToBytes(dataUrl) }
}

export function StagedAttachmentsProvider({ children }: { children: ReactNode }) {
  const attachments = usePromptInputAttachments()
  /**
   * SETTLED extraction results only, written exclusively from the async
   * callbacks below.
   *
   * Deliberately NOT the rendered map: pruning removed ids and inserting an
   * "extracting" placeholder used to be synchronous setState calls inside the
   * sync effect, which cascades renders (and the react-hooks lint rightly
   * rejects it). Both are derived instead — an id with no entry IS extracting,
   * and an id that is no longer live is simply never read.
   */
  const [results, setResults] = useState<ReadonlyMap<string, StagedAttachmentState>>(new Map())
  /** User-defined chip order. Written only from `reorder`, i.e. an event. */
  const [orderOverride, setOrderOverride] = useState<readonly string[]>([])
  // Ids whose extraction has been kicked off, so a re-render mid-flight cannot
  // schedule the same parse twice.
  const startedRef = useRef<Set<string>>(new Set())
  // Restored-draft extractions awaiting the file they belong to.
  const seedQueueRef = useRef<SeedEntry[]>([])

  const files = attachments.files
  // Stands in for the file list's identity; `files` is a fresh array each render.
  const fileKey = files.map((f) => f.id).join(",")

  useEffect(() => {
    const live = new Set(files.map((f) => f.id))
    startedRef.current.forEach((id) => {
      if (!live.has(id)) startedRef.current.delete(id)
    })

    let cancelled = false
    for (const file of files) {
      if (startedRef.current.has(file.id)) continue
      startedRef.current.add(file.id)

      // A restored draft's extraction, matched on filename because the vendored
      // provider mints ids internally and `add()` returns nothing.
      const seedIdx = seedQueueRef.current.findIndex((e) => e.filename === file.filename)
      if (seedIdx >= 0) {
        const [entry] = seedQueueRef.current.splice(seedIdx, 1)
        // Deferred to a microtask so this is not a synchronous setState in the
        // effect body — same reason as the async paths below.
        void Promise.resolve().then(() => {
          if (cancelled) return
          setResults((prev) => new Map(prev).set(file.id, entry!.state))
        })
        continue
      }

      const isImage = (file.mediaType ?? "").startsWith("image/")
      void (async () => {
        try {
          const url = file.url ?? ""
          const { dataUrl, size, bytes } = url.startsWith("blob:")
            ? await blobUrlToDataUrl(url)
            : { dataUrl: url, size: 0, bytes: undefined }
          const extracted = await extractAttachment({
            url: dataUrl,
            mediaType: file.mediaType,
            filename: file.filename,
            id: file.id,
          })
          if (cancelled) return
          setResults((prev) =>
            new Map(prev).set(file.id, {
              status: extracted.block ? "ready" : "rejected",
              sizeBytes: size,
              bytes,
              extracted,
            })
          )
        } catch (err) {
          loggers.chat.warn("attachment extraction failed", {
            err: err instanceof Error ? err.message : String(err),
          })
          if (cancelled) return
          setResults((prev) =>
            new Map(prev).set(file.id, {
              status: "rejected",
              sizeBytes: 0,
              extracted: {
                kind: isImage ? "image" : "document",
                block: null,
                tokens: 0,
                rejectReason: "parse-failed",
              },
            })
          )
        }
      })()
    }

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey])

  // ── Everything below is DERIVED from (live files × settled results) ────────
  const { byId, order, isExtracting, totalBytes, totalTokens, precomputed } = useMemo(() => {
    const map = new Map<string, StagedAttachmentState>()
    const precomputedMap = new Map<string, ExtractedAttachment>()
    let bytes = 0
    let tokens = 0
    let pending = false
    for (const file of files) {
      const settled = results.get(file.id)
      if (!settled) {
        // No result yet — that IS the extracting state, no placeholder needed.
        map.set(file.id, { status: "extracting", sizeBytes: 0 })
        pending = true
        continue
      }
      map.set(file.id, settled)
      bytes += settled.sizeBytes
      if (settled.extracted) {
        const outbound =
          settled.includeOcr && settled.ocrText
            ? withImageOcrText(settled.extracted, file.filename ?? "attachment", settled.ocrText)
            : settled.extracted
        precomputedMap.set(file.id, outbound)
        tokens += outbound.tokens
      }
    }
    return {
      byId: map as ReadonlyMap<string, StagedAttachmentState>,
      order: applyOrder(files, orderOverride).map((f) => f.id),
      isExtracting: pending,
      totalBytes: bytes,
      totalTokens: tokens,
      precomputed: precomputedMap as ReadonlyMap<string, ExtractedAttachment>,
    }
  }, [files, results, orderOverride])

  // Let `whenSettled()` resolve without polling: park resolvers here and flush
  // them the moment the last extraction lands. `isExtractingRef` mirrors the
  // derived value so a caller can take the synchronous fast path — the flush
  // effect only fires on a CHANGE, so a waiter parked while nothing is in
  // flight would otherwise never be resolved.
  const settleWaitersRef = useRef<Array<() => void>>([])
  const isExtractingRef = useRef(false)
  useEffect(() => {
    isExtractingRef.current = isExtracting
    if (isExtracting) return
    const waiters = settleWaitersRef.current
    settleWaitersRef.current = []
    waiters.forEach((resolve) => resolve())
  }, [isExtracting])

  const whenSettled = useCallback(() => {
    if (!isExtractingRef.current) return Promise.resolve()
    return new Promise<void>((resolve) => {
      settleWaitersRef.current.push(resolve)
    })
  }, [])

  const mutateResult = useCallback(
    (id: string, update: (cur: StagedAttachmentState) => StagedAttachmentState) =>
      setResults((prev) => {
        const cur = prev.get(id)
        if (!cur) return prev
        return new Map(prev).set(id, update(cur))
      }),
    []
  )

  const value = useMemo<StagedAttachmentsValue>(
    () => ({
      byId,
      order,
      isExtracting,
      totalBytes,
      totalTokens,
      precomputed,
      whenSettled,
      reorder: (activeId, overId) =>
        setOrderOverride((prev) => reorderIds(prev.length > 0 ? prev : order, activeId, overId)),
      setOcrText: (id, text) =>
        mutateResult(id, (cur) => ({ ...cur, ocrText: text, includeOcr: true })),
      toggleIncludeOcr: (id) =>
        mutateResult(id, (cur) => ({ ...cur, includeOcr: !cur.includeOcr })),
      seedIncoming: (entries) => {
        seedQueueRef.current.push(...entries)
      },
    }),
    [byId, order, isExtracting, totalBytes, totalTokens, precomputed, whenSettled, mutateResult]
  )

  return (
    <StagedAttachmentsContext.Provider value={value}>{children}</StagedAttachmentsContext.Provider>
  )
}
