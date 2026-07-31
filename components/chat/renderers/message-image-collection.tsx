"use client"

/**
 * One lightbox per message, shared by every image inside it.
 *
 * Before this existed each `ImageBlock` owned a private single-item
 * `ImageLightbox`, so an assistant turn with five markdown images gave you
 * five dead-end lightboxes with no way to page between them — while attachment
 * images (`MessageImageGallery`) had their own separate one. Mature chat UIs
 * treat the images in a turn as one navigable set; this provider is that set.
 *
 * Registration is intentionally ref-based, not state-based:
 *   - a streaming turn mounts image blocks continuously, and re-rendering the
 *     whole message on every registration would be pure churn;
 *   - the eslint config blocks synchronous set-state inside `useEffect`.
 * The ordered map is snapshotted into state only when a lightbox actually
 * opens, which is also exactly when "what's in this message right now" is the
 * correct answer.
 *
 * Registration order is mount order, which for a markdown subtree is
 * depth-first document order — i.e. reading order. Streaming only appends, so
 * the order stays stable as the turn grows.
 *
 * Consumers degrade gracefully: with no provider above them (attachment
 * preview sheet, settings previews, dialogs) they keep their own local
 * lightbox.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react"

import { ImageLightbox, type ImageLightboxItem } from "./image-lightbox"

export interface MessageImageCollection {
  /** Add an image to this message's set. Returns an unregister callback. */
  register: (item: ImageLightboxItem) => () => void
  /** Open the shared lightbox on `src`, restoring focus to `trigger` on close. */
  open: (src: string, trigger: HTMLElement | null) => void
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

export function MessageImageCollectionProvider({ children }: { children: React.ReactNode }) {
  // Insertion-ordered, deduped by src. A ref (not state) so registration never
  // re-renders the message — see the module comment.
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
      <ImageLightbox
        items={items}
        open={open}
        activeIndex={activeIndex}
        returnFocusRef={returnFocusRef}
        onActiveIndexChange={setActiveIndex}
        onOpenChange={setOpen}
      />
    </MessageImageCollectionContext.Provider>
  )
}
