"use client"

import { useEffect, type RefObject } from "react"

import { useStableCallback } from "@/hooks/ui/use-stable-callback"

/**
 * The text-entry surfaces of a conversation: the composer box (its skin
 * attribute is on the one root that holds the textarea, the `+` menu, the
 * voice button and the attachment tray) and every inline "edit and resend"
 * box (`data-message-edit`).
 */
export const TEXT_ENTRY_SURFACE_SELECTOR = "[data-composer-skin], [data-message-edit]"

/**
 * Close an inline message edit the moment the user starts working in another
 * text-entry surface.
 *
 * "Edit and resend" opens a second textarea inside the message list, and
 * nothing tied it to the composer below: a user could leave it open, then tap
 * the composer, attach a file, or dictate — and the attachment or the dictated
 * text went to the composer while the stale edit box stayed up beside it, two
 * editable surfaces with no telling which one the next send would use. The
 * edit is scoped to the moment it was opened for: engaging the composer, or
 * opening the edit on another message, cancels it. (The message itself is
 * untouched; the edit only ever held a working copy.)
 *
 * `pointerdown` as well as `focusin`, because on touch WebKit a tap on a
 * button does not move focus, so the `+` or microphone press would otherwise
 * slip past. Both listen in the capture phase so an overlay the tap opens (the
 * attachment sheet) cannot swallow them first.
 */
export function useEditYieldsToOtherSurfaces(
  active: boolean,
  ownSurfaceRef: RefObject<HTMLElement | null>,
  onYield: () => void
): void {
  const yieldEdit = useStableCallback(onYield)
  useEffect(() => {
    if (!active) return
    const onEngage = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const surface = target.closest(TEXT_ENTRY_SURFACE_SELECTOR)
      if (!surface) return
      const own = ownSurfaceRef.current
      if (own && (surface === own || own.contains(surface))) return
      yieldEdit()
    }
    document.addEventListener("focusin", onEngage, true)
    document.addEventListener("pointerdown", onEngage, true)
    return () => {
      document.removeEventListener("focusin", onEngage, true)
      document.removeEventListener("pointerdown", onEngage, true)
    }
  }, [active, ownSurfaceRef, yieldEdit])
}
