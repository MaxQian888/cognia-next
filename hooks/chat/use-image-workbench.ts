"use client"

/**
 * Everything the image workbench does, minus the pixels it draws.
 *
 * The hook owns four things that have to stay consistent with one another: the
 * decoded source, the undo history, the rendered preview, and the bitmaps that
 * AI checkpoints refer to. Splitting them across components is how you end up
 * revoking an object URL an `<img>` is still pointing at, so they live together.
 *
 * ## Two resolutions, on purpose
 *
 * A canonical chat image is 1568px. A tone adjustment over it touches roughly
 * 2.5 million pixels, which cannot keep up with a slider being dragged. So the
 * preview renders from a downscaled copy with the geometric steps scaled to
 * match, and the save re-renders the same history at full resolution. The user
 * gets a control that tracks their finger and a stored result that lost
 * nothing.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"

import {
  decodeUrlToPixelBuffer,
  encodeProviderMask,
  encodePixelBuffer,
  pixelBufferToBlob,
  rasterizeMask,
  resizeBuffer,
  ImageDecodeError,
  type MaskStroke,
  type PixelBuffer,
} from "@/lib/images"
import {
  currentPipeline,
  editorReducer,
  operationsForSave,
  releasedCheckpoints,
  attributionForSave,
  canRedo as canRedoOf,
  canUndo as canUndoOf,
  isDirty as isDirtyOf,
  INITIAL_EDITOR_STATE,
  type EditorEntry,
  type EditorState,
} from "@/lib/chat/image-edit/editor-state"
import {
  previewScaleFor,
  renderOperations,
  resolveSaveEncoding,
  scaleOperations,
} from "@/lib/chat/image-edit/render"
import {
  resolveImageEditCapabilities,
  runImageEdit,
  type ImageEditCapabilities,
  type ImageEditCapability,
  type ImageEditIntent,
} from "@/lib/chat/image-edit/ai-service"
import { saveImageEditVersion } from "@/lib/chat/image-edit/save"
import { newImageEditVersionId } from "@/lib/chat/image-edit/version"
import { loggers } from "@cognia/logging"

/** Which image is open, and where a saved version has to attach. */
export interface ImageWorkbenchSource {
  /** A displayable URL. The caller resolves media references before this. */
  url: string
  mediaType?: string
  filename?: string
  /** The originating image's url, which keys the lineage. */
  lineageId: string
  /** `null` when editing the original itself. */
  parentVersionId: string | null
}

export interface ImageWorkbenchTarget {
  sessionId: string
  messageId: string
  /**
   * Whether saving is possible at all.
   *
   * False while the turn is streaming or the session is read-only. The
   * workbench still opens: viewing, local editing and downloading are all still
   * useful, and the button explains itself instead of vanishing.
   */
  canSave: boolean
}

export type WorkbenchStatus = "loading" | "ready" | "error"

/** Why the pixels are unreachable, when they are. */
export type WorkbenchBlockReason = "cors" | "unsupported" | "decode"

export interface ImageWorkbenchAiState {
  capabilities: ImageEditCapabilities
  running: boolean
  error: { code: string; message: string; retryable: boolean } | null
  capability: ImageEditCapability | null
  selectCapability: (capability: ImageEditCapability) => void
  run: (intent: ImageEditIntent) => Promise<void>
  /** Paint strokes into a mask and run a region edit in one call. */
  runRegion: (prompt: string, strokes: readonly MaskStroke[]) => Promise<void>
  cancel: () => void
}

export interface ImageWorkbenchSaveState {
  saving: boolean
  error: string | null
  run: () => Promise<boolean>
}

export interface ImageWorkbench {
  status: WorkbenchStatus
  blocked: WorkbenchBlockReason | null
  /** Object URL of the current render. */
  previewUrl: string | null
  /** Object URL of the untouched source, for the compare control. */
  originalUrl: string | null
  /** Size of the CURRENT render in source pixels. */
  size: { width: number; height: number } | null
  state: EditorState
  canUndo: boolean
  canRedo: boolean
  isDirty: boolean
  apply: (entry: EditorEntry) => void
  undo: () => void
  redo: () => void
  reset: () => void
  jump: (cursor: number) => void
  ai: ImageWorkbenchAiState
  save: ImageWorkbenchSaveState
}

interface DecodedSource {
  url: string
  full: PixelBuffer
  preview: PixelBuffer
  scale: number
}

export interface UseImageWorkbenchOptions {
  source: ImageWorkbenchSource | null
  target: ImageWorkbenchTarget
  /** False while the dialog is closed, so nothing decodes in the background. */
  enabled: boolean
  /** Injected in tests. */
  deps?: Partial<WorkbenchDeps>
}

export interface WorkbenchDeps {
  decode: typeof decodeUrlToPixelBuffer
  toBlob: typeof pixelBufferToBlob
  encode: typeof encodePixelBuffer
  maskToProvider: typeof encodeProviderMask
  capabilities: typeof resolveImageEditCapabilities
  edit: typeof runImageEdit
  save: typeof saveImageEditVersion
}

const DEFAULT_DEPS: WorkbenchDeps = {
  decode: decodeUrlToPixelBuffer,
  toBlob: pixelBufferToBlob,
  encode: encodePixelBuffer,
  maskToProvider: encodeProviderMask,
  capabilities: resolveImageEditCapabilities,
  edit: runImageEdit,
  save: saveImageEditVersion,
}

const EMPTY_CAPABILITIES: ImageEditCapabilities = {
  options: [],
  preferred: null,
  unavailable: null,
}

function blockReasonOf(error: unknown): WorkbenchBlockReason {
  return error instanceof ImageDecodeError && error.reason !== "decode" ? error.reason : "decode"
}

export function useImageWorkbench({
  source,
  target,
  enabled,
  deps: injected,
}: UseImageWorkbenchOptions): ImageWorkbench {
  const deps = useMemo(() => ({ ...DEFAULT_DEPS, ...injected }), [injected])

  const [state, dispatch] = useReducer(editorReducer, INITIAL_EDITOR_STATE)
  const [decoded, setDecoded] = useState<DecodedSource | null>(null)
  const [blocked, setBlocked] = useState<WorkbenchBlockReason | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  const [openedUrl, setOpenedUrl] = useState<string | null>(source?.url ?? null)
  // Derived, not stored. Provider settings are read on every render the
  // workbench is open, so a key added in Settings while the dialog is up shows
  // up on the next interaction instead of needing a reopen.
  const capabilities = useMemo<ImageEditCapabilities>(
    () => (enabled ? deps.capabilities() : EMPTY_CAPABILITIES),
    [deps, enabled]
  )
  const [selectedCapability, setSelectedCapability] = useState<ImageEditCapability | null>(null)
  const capability = selectedCapability ?? capabilities.preferred
  const [aiRunning, setAiRunning] = useState(false)
  const [aiError, setAiError] = useState<ImageWorkbenchAiState["error"]>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * AI results, keyed by checkpoint id. A ref rather than state because these
   * are megabytes each and nothing renders from the map directly: the reducer
   * names an id, and the render effect looks it up.
   */
  const checkpointsRef = useRef(new Map<string, { full: PixelBuffer; mediaType: string }>())
  const abortRef = useRef<AbortController | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const originalUrlRef = useRef<string | null>(null)
  /**
   * Reused across every save attempt until one succeeds.
   *
   * This is the idempotency key. A save that fails on the network and is
   * retried must present the same id, or the retry becomes a second version.
   */
  const saveVersionIdRef = useRef<string | null>(null)

  // ── decode ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !source) return
    let cancelled = false
    deps
      .decode(source.url)
      .then((full) => {
        if (cancelled) return
        const scale = previewScaleFor(full)
        const preview =
          scale === 1
            ? full
            : resizeBuffer(full, Math.round(full.width * scale), Math.round(full.height * scale))
        setBlocked(null)
        setDecoded({ url: source.url, full, preview, scale })
      })
      .catch((error) => {
        if (cancelled) return
        loggers.chat.warn("image workbench decode failed", {
          err: error instanceof Error ? error.message : String(error),
        })
        setBlocked(blockReasonOf(error))
        setDecoded(null)
      })
    return () => {
      cancelled = true
    }
  }, [deps, enabled, source])

  // Opening a different image starts a fresh history. Carrying the old one over
  // would replay one image's crop onto another.
  //
  // Adjusted during render rather than in an effect. An effect would paint one
  // frame of the new image with the previous image's history still applied,
  // and the lint rule against synchronous set-state in effects exists for
  // exactly that cascade.
  if ((source?.url ?? null) !== openedUrl) {
    setOpenedUrl(source?.url ?? null)
    dispatch({ type: "reset" })
    setDecoded(null)
    setBlocked(null)
    setAiError(null)
    setSaveError(null)
    setSelectedCapability(null)
  }

  // The ref half of the same reset. Refs cannot be touched during render, and
  // this effect only clears them, so it never cascades a re-render.
  useEffect(() => {
    checkpointsRef.current.clear()
    saveVersionIdRef.current = null
  }, [openedUrl])

  // ── render the preview ────────────────────────────────────────────────────
  const pipeline = useMemo(() => currentPipeline(state), [state])

  useEffect(() => {
    if (!decoded) return
    let cancelled = false

    const base =
      pipeline.baseCheckpointId === null
        ? decoded
        : checkpointOf(checkpointsRef.current, pipeline.baseCheckpointId, decoded)
    const scale = base.scale
    const rendered = renderOperations(base.preview, scaleOperations(pipeline.operations, scale))

    deps
      .toBlob(rendered, "png")
      .then((blob) => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = url
        setPreviewUrl(url)
        // Reported in SOURCE pixels: the panel shows the size the save will
        // produce, not the size of the preview it happens to be looking at.
        setSize({
          width: Math.round(rendered.width / scale),
          height: Math.round(rendered.height / scale),
        })
      })
      .catch(() => {
        if (!cancelled) setBlocked("unsupported")
      })

    return () => {
      cancelled = true
    }
  }, [decoded, deps, pipeline])

  // ── the compare image ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!decoded) return
    let cancelled = false
    deps
      .toBlob(decoded.preview, "png")
      .then((blob) => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current)
        originalUrlRef.current = url
        setOriginalUrl(url)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [decoded, deps])

  // Revoking on unmount rather than on every change: the effects above already
  // revoke the URL they are replacing, and doing it here too would revoke one
  // the <img> is still displaying.
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current)
      previewUrlRef.current = null
      originalUrlRef.current = null
    },
    []
  )

  const apply = useCallback((entry: EditorEntry) => {
    dispatch({ type: "apply", entry })
  }, [])

  /** Drop the bitmaps the reducer just made unreachable. */
  const applyAndCollect = useCallback((previous: EditorState, next: EditorState) => {
    for (const id of releasedCheckpoints(previous, next)) checkpointsRef.current.delete(id)
  }, [])

  const stateRef = useRef(state)
  useEffect(() => {
    applyAndCollect(stateRef.current, state)
    stateRef.current = state
  }, [applyAndCollect, state])

  const runAi = useCallback(
    async (intent: ImageEditIntent) => {
      if (!decoded || !capability) return
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setAiRunning(true)
      setAiError(null)

      try {
        // The model edits what the user is looking at, which is the current
        // render at FULL resolution, not the original and not the preview.
        const base =
          pipeline.baseCheckpointId === null
            ? decoded
            : checkpointOf(checkpointsRef.current, pipeline.baseCheckpointId, decoded)
        const rendered = renderOperations(base.full, pipeline.operations)
        const encoded = await deps.encode(rendered, { format: "png" })

        const outcome = await deps.edit({
          image: { bytes: encoded.bytes, mediaType: encoded.mediaType },
          intent,
          capability,
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        if (!outcome.ok) {
          setAiError({
            code: outcome.code,
            message: outcome.message,
            retryable: outcome.retryable,
          })
          return
        }

        const url = URL.createObjectURL(
          new Blob([outcome.bytes as BlobPart], { type: outcome.mediaType })
        )
        try {
          const full = await deps.decode(url)
          const scale = previewScaleFor(full)
          checkpointsRef.current.set(url, {
            full,
            mediaType: outcome.mediaType,
          })
          const checkpoint: DecodedSource = {
            url,
            full,
            preview:
              scale === 1
                ? full
                : resizeBuffer(
                    full,
                    Math.round(full.width * scale),
                    Math.round(full.height * scale)
                  ),
            scale,
          }
          checkpointCache.set(url, checkpoint)
          dispatch({
            type: "apply",
            entry: {
              kind: "ai",
              checkpointId: url,
              operation: outcome.operation,
              ...(outcome.providerId ? { providerId: outcome.providerId } : {}),
              ...(outcome.modelId ? { modelId: outcome.modelId } : {}),
            },
          })
        } finally {
          URL.revokeObjectURL(url)
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        setAiRunning(false)
      }
    },
    [capability, decoded, deps, pipeline]
  )

  const runRegion = useCallback(
    async (prompt: string, strokes: readonly MaskStroke[]) => {
      if (!decoded) return
      const base =
        pipeline.baseCheckpointId === null
          ? decoded
          : checkpointOf(checkpointsRef.current, pipeline.baseCheckpointId, decoded)
      const rendered = renderOperations(base.full, pipeline.operations)
      const mask = rasterizeMask(strokes, { width: rendered.width, height: rendered.height })
      const payload = await deps.maskToProvider(mask)
      await runAi({ kind: "region", prompt, mask: payload })
    },
    [decoded, deps, pipeline, runAi]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setAiRunning(false)
  }, [])

  const runSave = useCallback(async (): Promise<boolean> => {
    if (!decoded || !source || !target.canSave) return false
    setSaving(true)
    setSaveError(null)
    try {
      const base =
        pipeline.baseCheckpointId === null
          ? decoded
          : checkpointOf(checkpointsRef.current, pipeline.baseCheckpointId, decoded)
      const checkpoint =
        pipeline.baseCheckpointId === null
          ? null
          : (checkpointsRef.current.get(pipeline.baseCheckpointId) ?? null)

      const rendered = renderOperations(base.full, pipeline.operations)
      const encoding = resolveSaveEncoding({
        buffer: rendered,
        operationCount: pipeline.operations.length,
        baseMediaType: checkpoint?.mediaType ?? null,
      })
      const payload = encoding.reuseBaseBytes
        ? await deps.encode(rendered, { format: "png" })
        : await deps.encode(rendered, { format: encoding.format })

      saveVersionIdRef.current ??= newImageEditVersionId()
      await deps.save({
        sessionId: target.sessionId,
        messageId: target.messageId,
        lineageId: source.lineageId,
        parentVersionId: source.parentVersionId,
        bytes: payload.bytes,
        mediaType: payload.mediaType,
        operations: operationsForSave(state),
        attribution: attributionForSave(state),
        versionId: saveVersionIdRef.current,
        ...(source.filename ? { filename: source.filename } : {}),
      })
      // Only cleared on success, so a retry after a failure reuses the id.
      saveVersionIdRef.current = null
      return true
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }, [decoded, deps, pipeline, source, state, target])

  return {
    status: blocked ? "error" : decoded ? "ready" : "loading",
    blocked,
    previewUrl,
    originalUrl,
    size,
    state,
    canUndo: canUndoOf(state),
    canRedo: canRedoOf(state),
    isDirty: isDirtyOf(state),
    apply,
    undo: useCallback(() => dispatch({ type: "undo" }), []),
    redo: useCallback(() => dispatch({ type: "redo" }), []),
    reset: useCallback(() => dispatch({ type: "reset" }), []),
    jump: useCallback((cursor: number) => dispatch({ type: "jump", cursor }), []),
    ai: {
      capabilities,
      running: aiRunning,
      error: aiError,
      capability,
      selectCapability: setSelectedCapability,
      run: runAi,
      runRegion,
      cancel,
    },
    save: { saving, error: saveError, run: runSave },
  }
}

/**
 * Preview-scaled twins of checkpoint bitmaps.
 *
 * Module-level rather than per-hook because a checkpoint's downscale is derived
 * purely from its own pixels, and recomputing it on every render of a large
 * frame is the one thing that would make undo feel slow.
 */
const checkpointCache = new Map<string, DecodedSource>()

function checkpointOf(
  checkpoints: Map<string, { full: PixelBuffer; mediaType: string }>,
  id: string,
  fallback: DecodedSource
): DecodedSource {
  const cached = checkpointCache.get(id)
  if (cached) return cached
  const entry = checkpoints.get(id)
  // A checkpoint the reducer still names but whose bitmap is gone can only
  // happen after an eviction race. Falling back to the source is wrong-looking
  // but bounded, and far better than rendering nothing.
  if (!entry) return fallback
  const scale = previewScaleFor(entry.full)
  const resolved: DecodedSource = {
    url: id,
    full: entry.full,
    preview:
      scale === 1
        ? entry.full
        : resizeBuffer(
            entry.full,
            Math.round(entry.full.width * scale),
            Math.round(entry.full.height * scale)
          ),
    scale,
  }
  checkpointCache.set(id, resolved)
  return resolved
}

/** Test seam: the module-level preview cache must not leak between suites. */
export function __clearWorkbenchCheckpointCacheForTests(): void {
  checkpointCache.clear()
}
