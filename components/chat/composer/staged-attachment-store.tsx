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
 *
 * Videos and GIFs take the motion pipeline (`lib/chat/attachments/video/`)
 * instead, and are never read into a data URL: a 500 MB source is sampled
 * straight from its blob URL. Their settings can be re-applied from the preview
 * panel, which cancels the run in flight and starts another.
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
  extractedFromVideoResult,
  withImageOcrText,
  type ExtractedAttachment,
  type RejectReason,
} from "@/lib/chat/attachments/dispatch"
import {
  COMPOSER_MAX_ATTACHMENT_BYTES,
  getOriginalComposerAttachment,
  prepareComposerAttachments,
} from "@/lib/chat/attachments/prepare"
import { DRAFT_ATTACHMENT_QUOTA_BYTES } from "@/lib/db/chat-drafts"
import { applyOrder, reorderIds } from "@/lib/chat/attachments/reorder"
import { isMotionDescriptor } from "@/lib/chat/attachments/video/classify"
import {
  VideoPreprocessError,
  type VideoPreprocessErrorReason,
} from "@/lib/chat/attachments/video/frame-source"
import {
  preprocessMotionAttachment,
  type VideoPreprocessResult,
} from "@/lib/chat/attachments/video/preprocess"
import {
  DEFAULT_VIDEO_SETTINGS,
  type VideoPreprocessSettings,
} from "@/lib/chat/attachments/video/settings"
import { loggers } from "@cognia/logging"
import { hashSessionAssetSource } from "@/lib/db/session-assets"
import { runAttachmentProcessing } from "@/lib/chat/attachments/processing-queue"
import {
  processAttachmentMedia,
  restoreDerivedAttachment,
  type AttachmentMediaOptions,
} from "@/lib/chat/attachments/media-extraction"
import {
  readAttachmentExtractedContent,
  type AttachmentExtractedContent,
} from "@cognia/agent-config-types/attachment"

export interface StagedAttachmentState {
  restoredContent?: AttachmentExtractedContent
  processing?: { processed: number; total: number }
  processingError?: string
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
  /** Present for a video or animated GIF: what was asked, and what came of it. */
  video?: StagedVideoState
}

export interface StagedVideoState {
  /** The settings of the run in flight, or of the last run. */
  settings: VideoPreprocessSettings
  /** The last successful run. Kept while a re-run is in flight, so the panel can keep showing it. */
  result?: VideoPreprocessResult
  /** 0..1 while a run is in flight. */
  progress?: number
  /** Why the last run failed. */
  error?: {
    reason: VideoPreprocessErrorReason
    ffmpeg: VideoPreprocessError["ffmpeg"]
    message: string
  }
}

export interface StagedAttachmentsValue {
  processMedia: (
    id: string,
    options: Pick<AttachmentMediaOptions, "method" | "providerId" | "modelId">
  ) => void
  cancelProcessing: (id: string) => void
  retry: (id: string) => void
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
  /** Re-run a video with new settings, cancelling any run in flight for it. */
  applyVideoSettings: (id: string, settings: VideoPreprocessSettings) => void
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

/** Map a failed motion run to the chip's machine-readable rejection. */
export function videoRejectReason(error: VideoPreprocessError): RejectReason {
  if (error.reason === "too-large") return "video-too-large"
  if (error.reason === "undecodable") return "video-undecodable"
  return "parse-failed"
}

/**
 * A blob's bytes through `FileReader`, the same reader the data-URL path above
 * uses. `Blob.arrayBuffer()` would do in every shipped WebView, but the jsdom
 * this store is tested in does not implement it.
 */
function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsArrayBuffer(blob)
  })
}

/** How often (as a fraction of the run) progress is written to state. */
const PROGRESS_STEP = 0.05

/** Read a staged blob URL back into a data URL, which is what extraction needs. */
async function blobUrlToDataUrl(
  url: string
): Promise<{ dataUrl: string; size: number; bytes: Uint8Array | undefined }> {
  const blob = await (await fetch(url)).blob()
  return blobToDataUrl(blob)
}

async function blobToDataUrl(
  blob: Blob
): Promise<{ dataUrl: string; size: number; bytes: Uint8Array | undefined }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(blob)
  })
  return { dataUrl, size: blob.size, bytes: dataUrlToBytes(dataUrl) }
}

export interface StagedAttachmentsProviderProps {
  children: ReactNode
  /**
   * Whether videos and animated GIFs take the motion pipeline. Off for a
   * conversation whose files go to a person rather than a model (an IM
   * binding): there a GIF is forwarded as the picture it is, and sampling
   * frames nobody will read would only spend the CPU. Default on.
   */
  motion?: boolean
}

export function StagedAttachmentsProvider({
  children,
  motion = true,
}: StagedAttachmentsProviderProps) {
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
  const [retryEpoch, setRetryEpoch] = useState(0)
  // Ids whose extraction has been kicked off, so a re-render mid-flight cannot
  // schedule the same parse twice.
  const startedRef = useRef<Set<string>>(new Set())
  // Restored-draft extractions awaiting the file they belong to.
  const seedQueueRef = useRef<SeedEntry[]>([])
  const restoredContentRef = useRef<Map<string, AttachmentExtractedContent>>(new Map())
  const restoredOcrRef = useRef<Map<string, Pick<StagedAttachmentState, "ocrText" | "includeOcr">>>(
    new Map()
  )
  // The motion run in flight per attachment id, so a re-apply or a removal can
  // cancel it instead of letting a stale result land.
  const motionRunsRef = useRef<Map<string, AbortController>>(new Map())

  const files = attachments.files
  // Stands in for the file list's identity; `files` is a fresh array each render.
  const fileKey = files.map((f) => f.id).join(",")

  /**
   * Run the motion pipeline for one staged file. Only ever called from an
   * effect's async body or an event handler, so its state writes are never
   * synchronous in render or in an effect body.
   */
  const runMotion = useCallback(
    (
      file: { id: string; url?: string; filename?: string; mediaType?: string; sourceFile?: File },
      settings: VideoPreprocessSettings,
      imageFallback: () => void
    ) => {
      motionRunsRef.current.get(file.id)?.abort()
      const controller = new AbortController()
      motionRunsRef.current.set(file.id, controller)
      const filename = file.filename ?? "attachment"
      const isCurrent = () =>
        motionRunsRef.current.get(file.id) === controller && !controller.signal.aborted

      void runAttachmentProcessing(async () => {
        let sizeBytes = 0
        try {
          const blob = file.sourceFile
            ? getOriginalComposerAttachment(file.sourceFile)
            : await (await fetch(file.url ?? "")).blob()
          sizeBytes = blob.size
          if (!isCurrent()) return
          setResults((prev) => {
            const cur = prev.get(file.id)
            return new Map(prev).set(file.id, {
              ...(cur ?? {}),
              status: "extracting",
              sizeBytes,
              video: { settings, result: cur?.video?.result, progress: 0 },
            })
          })
          let lastProgress = 0
          const outcome = await preprocessMotionAttachment({
            blob,
            filename,
            mediaType: file.mediaType ?? blob.type,
            settings,
            signal: controller.signal,
            onProgress: (fraction) => {
              if (fraction < 1 && fraction - lastProgress < PROGRESS_STEP) return
              lastProgress = fraction
              if (!isCurrent()) return
              setResults((prev) => {
                const cur = prev.get(file.id)
                if (!cur?.video) return prev
                return new Map(prev).set(file.id, {
                  ...cur,
                  video: { ...cur.video, progress: fraction },
                })
              })
            },
          })
          if (!isCurrent()) return
          if (outcome.kind === "still-gif") {
            // A GIF with one frame is a picture: hand it to the image path.
            motionRunsRef.current.delete(file.id)
            imageFallback()
            return
          }
          // Only a source small enough to send natively is kept for a draft;
          // anything larger comes back as a name-only chip, like an evicted blob.
          const bytes =
            blob.size <= COMPOSER_MAX_ATTACHMENT_BYTES ? await readBlobBytes(blob) : undefined
          if (!isCurrent()) return
          const sourceHash = await hashSessionAssetSource(blob)
          if (!isCurrent()) return
          let extracted = extractedFromVideoResult(outcome.result, { filename, groupId: file.id })
          extracted.original = blob
          extracted.extractedContent = {
            attachmentId: file.id,
            contentHash: sourceHash,
            status: "partial",
            segments: [],
            processor: { id: "cognia-video", version: "2" },
            issues: ["video-visual-sampling", "audio-not-transcribed"],
          }
          const restoredContent = restoredContentRef.current.get(file.id)
          if (restoredContent) {
            extracted = restoreDerivedAttachment(
              extracted,
              { ...restoredContent, attachmentId: file.id },
              filename
            )
            restoredContentRef.current.delete(file.id)
          }
          motionRunsRef.current.delete(file.id)
          setResults((prev) =>
            new Map(prev).set(file.id, {
              status: "ready",
              sizeBytes,
              ...(bytes ? { bytes } : {}),
              extracted,
              video: { settings: outcome.result.settings, result: outcome.result },
            })
          )
        } catch (err) {
          if (!isCurrent()) return
          motionRunsRef.current.delete(file.id)
          const error =
            err instanceof VideoPreprocessError
              ? err
              : new VideoPreprocessError("failed", err instanceof Error ? err.message : String(err))
          if (error.reason === "aborted") return
          loggers.chat.warn("video preprocessing failed", {
            reason: error.reason,
            ffmpeg: error.ffmpeg,
            err: error.message,
          })
          setResults((prev) =>
            new Map(prev).set(file.id, {
              status: "rejected",
              sizeBytes,
              extracted: {
                kind: "video",
                block: null,
                tokens: 0,
                rejectReason: videoRejectReason(error),
              },
              video: {
                settings,
                error: { reason: error.reason, ffmpeg: error.ffmpeg, message: error.message },
              },
            })
          )
        }
      }, controller.signal).catch(() => {})
    },
    []
  )

  useEffect(() => {
    const live = new Set(files.map((f) => f.id))
    startedRef.current.forEach((id) => {
      if (!live.has(id)) startedRef.current.delete(id)
    })
    // A removed attachment's run has nobody left to report to.
    motionRunsRef.current.forEach((controller, id) => {
      if (live.has(id)) return
      controller.abort()
      motionRunsRef.current.delete(id)
    })
    restoredContentRef.current.forEach((_, id) => {
      if (!live.has(id)) restoredContentRef.current.delete(id)
    })
    restoredOcrRef.current.forEach((_, id) => {
      if (!live.has(id)) restoredOcrRef.current.delete(id)
    })
    // Removed large sources must not stay retained in the settled result cache.
    // Defer the state write; use the current started set if more files arrive.
    void Promise.resolve().then(() =>
      setResults((prev) => {
        const next = new Map([...prev].filter(([id]) => startedRef.current.has(id)))
        return next.size === prev.size ? prev : next
      })
    )

    // Whether a result still has a chip to land on. NOT a per-run `cancelled`
    // flag: this effect re-runs every time a file is added, and a flag flipped
    // by that cleanup dropped the result of any extraction still in flight —
    // the earlier chip then spun forever and `whenSettled` never resolved. A
    // removed chip is pruned from `startedRef` above, which is the real signal.
    const stillStaged = (id: string) => startedRef.current.has(id)
    for (const file of files) {
      if (startedRef.current.has(file.id)) continue
      startedRef.current.add(file.id)

      const isMotion =
        motion &&
        isMotionDescriptor({
          name: file.filename ?? "",
          mediaType: file.mediaType ?? "",
        })

      // A restored draft's extraction, matched on filename because the vendored
      // provider mints ids internally and `add()` returns nothing.
      const seedIdx = seedQueueRef.current.findIndex((e) => e.filename === file.filename)
      const entry = seedIdx >= 0 ? seedQueueRef.current.splice(seedIdx, 1)[0] : undefined
      const restoredContent = readAttachmentExtractedContent(entry?.state.restoredContent)
      if (restoredContent) restoredContentRef.current.set(file.id, restoredContent)
      if (entry?.state.ocrText)
        restoredOcrRef.current.set(file.id, {
          ocrText: entry.state.ocrText,
          includeOcr: entry.state.includeOcr,
        })
      if (entry && isMotion) {
        // Sampled frames are not persisted with a draft, only the settings that
        // produced them: re-run with those.
        runMotion(file, entry!.state.video?.settings ?? DEFAULT_VIDEO_SETTINGS, () =>
          extractAsDocumentOrImage(file)
        )
        continue
      }
      const cachedContent = readAttachmentExtractedContent(entry?.state.extracted?.extractedContent)
      if (entry?.state.extracted && cachedContent) {
        // Deferred to a microtask so this is not a synchronous setState in the
        // effect body — same reason as the async paths below.
        void (async () => {
          const blob = file.sourceFile
            ? getOriginalComposerAttachment(file.sourceFile)
            : await (await fetch(file.url ?? "")).blob()
          const hash = await hashSessionAssetSource(blob)
          if (!stillStaged(file.id)) return
          if (hash !== cachedContent.contentHash) {
            extractAsDocumentOrImage(file)
            return
          }
          if (!stillStaged(file.id)) return
          const extracted = entry!.state.extracted!
          setResults((prev) =>
            new Map(prev).set(file.id, {
              ...entry!.state,
              extracted: {
                ...extracted,
                original: blob,
                extractedContent: { ...extracted.extractedContent!, attachmentId: file.id },
              },
            })
          )
        })().catch(() => {
          if (stillStaged(file.id)) extractAsDocumentOrImage(file)
        })
        continue
      }

      if (isMotion) {
        runMotion(file, DEFAULT_VIDEO_SETTINGS, () => extractAsDocumentOrImage(file))
        continue
      }
      extractAsDocumentOrImage(file)
    }

    function extractAsDocumentOrImage(file: (typeof files)[number]) {
      const controller = new AbortController()
      motionRunsRef.current.get(file.id)?.abort()
      motionRunsRef.current.set(file.id, controller)
      const isImage = (file.mediaType ?? "").startsWith("image/")
      void runAttachmentProcessing(async () => {
        try {
          controller.signal.throwIfAborted()
          setResults((prev) =>
            new Map(prev).set(file.id, {
              status: "extracting",
              sizeBytes: prev.get(file.id)?.sizeBytes ?? 0,
            })
          )
          const url = file.url ?? ""
          const source = file.sourceFile
            ? getOriginalComposerAttachment(file.sourceFile)
            : undefined
          const restoredLargeImage =
            isImage && file.sourceFile && file.sourceFile.size > COMPOSER_MAX_ATTACHMENT_BYTES
          let payload: Awaited<ReturnType<typeof blobToDataUrl>>
          let payloadMediaType = file.mediaType
          if (restoredLargeImage) {
            const prepared = await prepareComposerAttachments([file.sourceFile!], {
              maxFileSize: COMPOSER_MAX_ATTACHMENT_BYTES,
            })
            if (!prepared.files[0]) throw new Error("attachment_image_preparation_failed")
            payloadMediaType = prepared.files[0].type
            payload = await blobToDataUrl(prepared.files[0])
          } else {
            payload = url.startsWith("blob:")
              ? await blobUrlToDataUrl(url)
              : { dataUrl: url, size: 0, bytes: undefined }
          }
          const { dataUrl, size, bytes } = payload
          controller.signal.throwIfAborted()
          let extracted = await extractAttachment(
            {
              url: dataUrl,
              mediaType: payloadMediaType,
              filename: file.filename,
              id: file.id,
            },
            {
              signal: controller.signal,
              onProgress: (processing) => {
                if (controller.signal.aborted || !stillStaged(file.id)) return
                setResults((prev) =>
                  new Map(prev).set(file.id, {
                    ...(prev.get(file.id) ?? { status: "extracting", sizeBytes: size }),
                    processing,
                  })
                )
              },
            }
          )
          // Preparation may resize an image for the model. Bind provenance to
          // the actual uploaded source, which the provider retains by identity.
          const original =
            source && (source !== file.sourceFile || restoredLargeImage) ? source : undefined
          let sourceBytes = bytes
          if (original && extracted.extractedContent) {
            extracted = {
              ...extracted,
              original,
              extractedContent: {
                ...extracted.extractedContent,
                contentHash: await hashSessionAssetSource(original),
              },
            }
            sourceBytes =
              original.size <= DRAFT_ATTACHMENT_QUOTA_BYTES
                ? await readBlobBytes(original)
                : undefined
          }
          const restoredContent = restoredContentRef.current.get(file.id)
          if (restoredContent) {
            extracted = restoreDerivedAttachment(
              extracted,
              { ...restoredContent, attachmentId: file.id },
              file.filename ?? "attachment"
            )
            restoredContentRef.current.delete(file.id)
          }
          if (!stillStaged(file.id) || controller.signal.aborted) return
          motionRunsRef.current.delete(file.id)
          const restoredOcr = restoredOcrRef.current.get(file.id)
          restoredOcrRef.current.delete(file.id)
          setResults((prev) =>
            new Map(prev).set(file.id, {
              ...restoredOcr,
              status: extracted.block ? "ready" : "rejected",
              sizeBytes: original?.size ?? size,
              bytes: sourceBytes,
              extracted,
            })
          )
        } catch (err) {
          loggers.chat.warn("attachment extraction failed", {
            err: err instanceof Error ? err.message : String(err),
          })
          if (!stillStaged(file.id) || controller.signal.aborted) return
          motionRunsRef.current.delete(file.id)
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
      }, controller.signal).catch(() => {})
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, retryEpoch])

  // Cancel every run on unmount.
  useEffect(() => {
    const runs = motionRunsRef.current
    const started = startedRef.current
    const restored = restoredContentRef.current
    const restoredOcr = restoredOcrRef.current
    const seeds = seedQueueRef.current
    const waiters = settleWaitersRef.current
    return () => {
      started.clear()
      restored.clear()
      restoredOcr.clear()
      seeds.splice(0)
      runs.forEach((controller) => controller.abort())
      runs.clear()
      waiters.splice(0).forEach((resolve) => resolve())
    }
  }, [])

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
      if (settled.status === "extracting") {
        // A video being (re-)processed: shown, but not sendable until it lands.
        map.set(file.id, settled)
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
    const waiters = settleWaitersRef.current.splice(0)
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
      processMedia: (id, options) => {
        const current = results.get(id)
        const file = files.find((entry) => entry.id === id)
        if (!current?.extracted || !file) return
        motionRunsRef.current.get(id)?.abort()
        const controller = new AbortController()
        motionRunsRef.current.set(id, controller)
        setResults((prev) =>
          new Map(prev).set(id, {
            ...current,
            status: "extracting",
            processing: { processed: 0, total: 1 },
            processingError: undefined,
          })
        )
        void runAttachmentProcessing(
          () =>
            processAttachmentMedia(current.extracted!, file.filename ?? "attachment", {
              ...options,
              signal: controller.signal,
              onProgress: (processing) => {
                if (controller.signal.aborted) return
                mutateResult(id, (cur) => ({ ...cur, processing }))
              },
            }),
          controller.signal
        )
          .then((extracted) => {
            if (motionRunsRef.current.get(id) !== controller || !startedRef.current.has(id)) return
            motionRunsRef.current.delete(id)
            setResults((prev) =>
              new Map(prev).set(id, {
                ...current,
                extracted,
                status: extracted.block ? "ready" : "rejected",
                processingError: extracted.extractedContent?.issues?.find(
                  (issue) => issue.startsWith("attachment_") || issue === "processing-cancelled"
                ),
              })
            )
          })
          .catch(() => {
            if (motionRunsRef.current.get(id) !== controller) return
            motionRunsRef.current.delete(id)
            setResults((prev) =>
              new Map(prev).set(id, { ...current, processingError: "processing-failed" })
            )
          })
      },
      cancelProcessing: (id) => {
        motionRunsRef.current.get(id)?.abort()
        motionRunsRef.current.delete(id)
        mutateResult(id, (cur) => ({
          ...cur,
          status: cur.extracted?.block ? "ready" : "rejected",
          processingError: "processing-cancelled",
        }))
      },
      retry: (id) => {
        const content = results.get(id)?.extracted?.extractedContent
        if (content) restoredContentRef.current.set(id, content)
        motionRunsRef.current.get(id)?.abort()
        startedRef.current.delete(id)
        setRetryEpoch((epoch) => epoch + 1)
      },
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
      applyVideoSettings: (id, settings) => {
        const file = files.find((f) => f.id === id)
        if (!file) return
        const content = results.get(id)?.extracted?.extractedContent
        if (content) restoredContentRef.current.set(id, content)
        runMotion(file, settings, () => {
          // A still GIF never reaches the panel's controls; nothing to re-run.
        })
      },
      seedIncoming: (entries) => {
        seedQueueRef.current.push(...entries)
      },
    }),
    [
      byId,
      order,
      isExtracting,
      totalBytes,
      totalTokens,
      precomputed,
      whenSettled,
      mutateResult,
      files,
      results,
      runMotion,
    ]
  )

  return (
    <StagedAttachmentsContext.Provider value={value}>{children}</StagedAttachmentsContext.Provider>
  )
}
