"use client"

/**
 * One image surface per message, shared by every image inside it.
 *
 * Before this existed each `ImageBlock` owned a private single-item
 * `ImageLightbox`, so an assistant turn with five markdown images gave you
 * five dead-end lightboxes with no way to page between them, while attachment
 * images (`MessageImageGallery`) had their own separate one. Mature chat UIs
 * treat the images in a turn as one navigable set. This provider is that set.
 *
 * Registration is intentionally ref-based, not state-based:
 *   - a streaming turn mounts image blocks continuously, and re-rendering the
 *     whole message on every registration would be pure churn
 *   - the eslint config blocks synchronous set-state inside `useEffect`
 * The ordered map is snapshotted into state only when the viewer actually
 * opens, which is also exactly when "what's in this message right now" is the
 * correct answer.
 *
 * Registration order is mount order, which for a markdown subtree is
 * depth-first document order, that is reading order. Streaming only appends, so
 * the order stays stable as the turn grows.
 *
 * ## Why there are two surfaces
 *
 * Given a `target`, the images open in the full workbench: viewing plus
 * cropping, adjusting, AI editing and saving a new version onto this message.
 * Without one (attachment preview sheet, settings previews, dialogs) there is
 * no message to attach a version to, so the read-only `ImageLightbox` is the
 * honest surface rather than a workbench whose save button could never work.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import {
  groupImageLineages,
  lineageContaining,
  readImageEditVersion,
} from "@/lib/chat/image-edit/version"
import { downloadFromUrl } from "@/lib/files/download"
import { getDb } from "@/lib/db/schema"
import { useMediaUrl } from "@/hooks/chat/use-media-url"
import { ImageWorkbench } from "@/components/chat/image-workbench/image-workbench"
import { railItemsFromLineages } from "@/components/chat/image-workbench/version-rail"
import { loggers } from "@cognia/logging"

import { ImageLightbox, type ImageLightboxItem } from "./image-lightbox"

export interface MessageImageCollection {
  /** Add an image to this message's set. Returns an unregister callback. */
  register: (item: ImageLightboxItem) => () => void
  /** Open the shared viewer on `src`, restoring focus to `trigger` on close. */
  open: (src: string, trigger: HTMLElement | null) => void
}

/** What an edit needs in order to be savable back onto the message. */
export interface MessageImageTarget {
  sessionId: string
  messageId: string
  /** The message's parts, which is where the version lineage lives. */
  parts: readonly unknown[]
  /** A streaming turn is still being written, so a version cannot land on it. */
  isStreaming: boolean
}

const MessageImageCollectionContext = createContext<MessageImageCollection | null>(null)

/**
 * Returns the enclosing message's image collection, or `null` when the image
 * is rendered outside a message (in which case the caller keeps its own
 * lightbox).
 */
export function useMessageImageCollection(): MessageImageCollection | null {
  return useContext(MessageImageCollectionContext)
}

export function MessageImageCollectionProvider({
  children,
  target,
}: {
  children: React.ReactNode
  target?: MessageImageTarget
}) {
  // Insertion-ordered, deduped by src. A ref (not state) so registration never
  // re-renders the message. See the module comment.
  const entriesRef = useRef<Map<string, ImageLightboxItem>>(new Map())
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [items, setItems] = useState<ImageLightboxItem[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [open, setOpen] = useState(false)

  const register = useCallback((item: ImageLightboxItem) => {
    const map = entriesRef.current
    // First registration wins: a re-render that supplies a thinner alt/title
    // for an image already in the set must not downgrade the existing entry.
    if (!map.has(item.src)) map.set(item.src, item)
    return () => {
      map.delete(item.src)
    }
  }, [])

  const openAt = useCallback((src: string, trigger: HTMLElement | null) => {
    const snapshot = [...entriesRef.current.values()]
    if (snapshot.length === 0) return
    const index = snapshot.findIndex((entry) => entry.src === src)
    returnFocusRef.current = trigger
    setItems(snapshot)
    setActiveIndex(index < 0 ? 0 : index)
    setOpen(true)
  }, [])

  const value = useMemo<MessageImageCollection>(
    () => ({ register, open: openAt }),
    [register, openAt]
  )

  return (
    <MessageImageCollectionContext.Provider value={value}>
      {children}
      {target ? (
        <MessageImageWorkbench
          items={items}
          open={open}
          activeIndex={activeIndex}
          entriesRef={entriesRef}
          target={target}
          onActiveIndexChange={setActiveIndex}
          onOpenChange={setOpen}
        />
      ) : (
        <ImageLightbox
          items={items}
          open={open}
          activeIndex={activeIndex}
          returnFocusRef={returnFocusRef}
          onActiveIndexChange={setActiveIndex}
          onOpenChange={setOpen}
        />
      )}
    </MessageImageCollectionContext.Provider>
  )
}

interface MessageImageWorkbenchProps {
  items: ImageLightboxItem[]
  open: boolean
  activeIndex: number
  entriesRef: React.RefObject<Map<string, ImageLightboxItem>>
  target: MessageImageTarget
  onActiveIndexChange: (index: number) => void
  onOpenChange: (open: boolean) => void
}

/**
 * Bridges the registered image set to the workbench.
 *
 * Its whole job is turning "the image the user clicked" into "which lineage of
 * which message this belongs to", because the workbench needs the part url to
 * attach a version and the renderer only ever knew the object URL it painted.
 */
function MessageImageWorkbench({
  items,
  open,
  activeIndex,
  entriesRef,
  target,
  onActiveIndexChange,
  onOpenChange,
}: MessageImageWorkbenchProps) {
  const safeIndex = Math.min(Math.max(activeIndex, 0), Math.max(items.length - 1, 0))
  const activeItem = items[safeIndex]

  // The canonical variant, not the gallery thumbnail. Editing the thumbnail
  // would silently downscale the saved version to 512px.
  const canonical = useMediaUrl(open ? activeItem?.sourceRef : null)

  /**
   * Read once per opened dialog, not once per rendered message.
   *
   * A handoff-locked conversation refuses every write at the database, so
   * without this the save button would look live, spend a full re-encode, and
   * then fail. The database guard stays authoritative either way: this only
   * decides whether to offer the button.
   */
  const lockedSession = useLiveQuery(
    async () =>
      open ? ((await getDb().sessions.get(target.sessionId))?.handoffLock ?? null) : null,
    [open, target.sessionId]
  )
  const writable = !lockedSession

  const lineages = useMemo(() => groupImageLineages(target.parts), [target.parts])

  // Display urls come from the open-time snapshot, which is state. A version
  // saved while the workbench is open is not in it yet, so the rail resolves
  // content-addressed references itself rather than reading the registration
  // ref during render.
  const rail = useMemo(() => {
    const displayUrls = new Map(items.map((entry) => [entry.id, entry.src]))
    return railItemsFromLineages(lineages, (url) => displayUrls.get(url) ?? url)
  }, [items, lineages])

  const source = useMemo(() => {
    if (!activeItem) return null
    // `id` is the part's url. `src` is whatever the renderer resolved it to.
    const lineage = lineageContaining(lineages, activeItem.id)
    const entry = lineage?.entries.find((candidate) => candidate.url === activeItem.id)
    return {
      url: canonical.status === "ready" && canonical.url ? canonical.url : activeItem.src,
      ...(activeItem.filename ? { filename: activeItem.filename } : {}),
      // With no lineage (an image the message no longer lists, such as a
      // legacy inline data URL) the image is its own origin.
      lineageId: lineage?.lineageId ?? activeItem.id,
      parentVersionId: entry ? (readImageEditVersion(entry.part)?.versionId ?? null) : null,
    }
  }, [activeItem, canonical.status, canonical.url, lineages])

  const selectByUrl = useCallback(
    (url: string) => {
      // Re-snapshotted rather than searched in `items`: a version saved while
      // the workbench was open registers after the snapshot was taken.
      const snapshot = [...entriesRef.current.values()]
      const index = snapshot.findIndex((entry) => entry.id === url)
      if (index < 0) return
      onActiveIndexChange(index)
    },
    [entriesRef, onActiveIndexChange]
  )

  const handleDownload = useCallback(async () => {
    if (!activeItem) return
    const url = canonical.status === "ready" && canonical.url ? canonical.url : activeItem.src
    const filename = activeItem.filename || activeItem.title || "image"
    try {
      await downloadFromUrl(url, filename, { fetchAsBlob: true })
    } catch (error) {
      loggers.chat.warn("image download failed", {
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }, [activeItem, canonical.status, canonical.url])

  if (!activeItem) return null

  const saveBlockedReason = target.isStreaming
    ? ("streaming" as const)
    : !writable
      ? ("read-only" as const)
      : null

  return (
    <ImageWorkbench
      open={open}
      onOpenChange={onOpenChange}
      source={source}
      target={{
        sessionId: target.sessionId,
        messageId: target.messageId,
        canSave: saveBlockedReason === null,
      }}
      saveBlockedReason={saveBlockedReason}
      rail={rail}
      onSelectVersion={selectByUrl}
      canGoPrevious={safeIndex > 0}
      canGoNext={safeIndex < items.length - 1}
      onPrevious={() => onActiveIndexChange(safeIndex - 1)}
      onNext={() => onActiveIndexChange(safeIndex + 1)}
      onDownload={() => void handleDownload()}
      title={activeItem.filename || activeItem.title || activeItem.alt || "Image"}
    />
  )
}
