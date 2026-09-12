"use client"

/**
 * Select mode for the artifact preview: arm the picker, and decide where a
 * picked element goes.
 *
 * Two destinations, because they are two different intents and the repo already
 * distinguishes them:
 *
 * - **Stage** (a plain click) puts the element in the composer as an
 *   `ArtifactSelectionRef`. That kind is documented in `types/artifact/artifact.ts`
 *   as *the only kind eligible to be the edit target* — it is what lets the
 *   reply come back as a revision proposal diffed against this artifact. Going
 *   straight to a durable annotation instead would have quietly forfeited
 *   exactly the thing element picking is for ("make this button blue" → a diff).
 * - **Send now** (⌘/Ctrl-click) ships it immediately, for when the user wants
 *   one change and not a basket of them.
 *
 * Staging also lets the user pick several elements and write one instruction
 * covering all of them, which a per-pick send cannot express.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  armArtifactPicker,
  canPickArtifactElements,
  disarmArtifactPicker,
  subscribeToArtifactPickers,
  type ArtifactPickModifiers,
} from "@/lib/artifacts/element-pick-registry"
import { useChatStore } from "@/stores/chat"
import type { Artifact } from "@/types"
import type { ElementSelectionCore } from "@/types/element-selection"

/**
 * What the prompt heading calls this surface. English: it is prompt
 * scaffolding, not UI copy (see `lib/artifacts/format-selection-context.ts`).
 */
export const ARTIFACT_PICK_ORIGIN = "artifact preview"

/**
 * Where the element's markup sits in the artifact SOURCE, as a 1-based
 * inclusive line range.
 *
 * The range is the diff anchor, so it has to be a real range even when the
 * rendered node cannot be traced back to source. Three cases:
 *
 * - the markup appears verbatim (an `html` or `svg` artifact): use it;
 * - a distinctive opening tag matches (the renderer normalised attributes, or
 *   the artifact is JSX whose output only resembles its source): use that line;
 * - nothing matches (a chart drawn from data, a React tree with no textual
 *   counterpart): name the whole artifact, which is honest — the model is being
 *   asked to change a document it must read in full anyway.
 */
export function locateElementRange(
  content: string,
  element: ElementSelectionCore
): { startLine: number; endLine: number } {
  const totalLines = content.split("\n").length
  const whole = { startLine: 1, endLine: totalLines }

  const lineOf = (index: number) => content.slice(0, index).split("\n").length
  const verbatim = element.outerHTML ? content.indexOf(element.outerHTML) : -1
  if (verbatim !== -1) {
    const startLine = lineOf(verbatim)
    return { startLine, endLine: startLine + element.outerHTML.split("\n").length - 1 }
  }

  // An id is the strongest single-attribute anchor, then a full class list,
  // then the bare tag — each tried only when it actually narrows anything.
  const candidates = [
    element.id ? `id="${element.id}"` : null,
    element.classes ? `class="${element.classes}"` : null,
  ].filter((value): value is string => value !== null)
  for (const needle of candidates) {
    const at = content.indexOf(needle)
    if (at !== -1) {
      const startLine = lineOf(at)
      return { startLine, endLine: startLine }
    }
  }
  return whole
}

export interface UseArtifactElementSelection {
  /** Whether the preview can be pointed at right now. */
  available: boolean
  /** Whether the picker is armed. */
  selectMode: boolean
  toggleSelectMode: () => void
  /** How many elements this session has staged, for the toolbar's badge. */
  pickedCount: number
}

export interface UseArtifactElementSelectionOptions {
  artifact: Artifact | null | undefined
  /** True while the surface that owns the preview is actually showing it. */
  previewVisible: boolean
  /** Ship one element straight to chat. Injected so the hook stays testable. */
  sendNow?: (selection: ElementSelectionCore, artifact: Artifact) => void | Promise<void>
}

export function useArtifactElementSelection({
  artifact,
  previewVisible,
  sendNow,
}: UseArtifactElementSelectionOptions): UseArtifactElementSelection {
  const t = useTranslations("artifacts.elementPick")
  const addContextSelection = useChatStore((state) => state.addContextSelection)
  const artifactId = artifact?.id

  /**
   * Whether a preview has registered a picker for this artifact.
   *
   * Subscribed rather than read once: the preview registers while it mounts,
   * which is after this hook's host has already rendered. A plain read would
   * leave the toolbar's toggle disabled over a preview that is perfectly
   * pickable, and nothing would ever re-render it.
   */
  const hasPicker = useSyncExternalStore(
    subscribeToArtifactPickers,
    () => canPickArtifactElements(artifactId),
    // Server render: no preview is mounted, so nothing can be pointed at.
    () => false
  )
  const available = previewVisible && hasPicker

  const [selectModeRequested, setSelectModeRequested] = useState(false)
  const [pickedCount, setPickedCount] = useState(0)

  /**
   * Select mode is DERIVED, not reset.
   *
   * Hiding the preview or losing the picker must end select mode — an armed
   * picker the user cannot see swallows clicks with no visible cause. Writing
   * that as an effect meant a `setState` per visibility change, a cascading
   * render, and a window where the two disagreed. Conjunction says the same
   * thing with no state at all, and re-showing the preview restores the mode
   * the user last asked for.
   */
  const selectMode = selectModeRequested && available

  // Moving to another artifact drops both the mode and the tally. Adjusted
  // during render (React's "adjusting state on prop change"), which is the
  // pattern the rest of this repo's panels use — an effect here would paint one
  // frame of the previous artifact's count.
  const [syncedArtifactId, setSyncedArtifactId] = useState(artifactId)
  if (artifactId !== syncedArtifactId) {
    setSyncedArtifactId(artifactId)
    setSelectModeRequested(false)
    setPickedCount(0)
  }

  // The picker is armed against a live preview, so everything it needs is read
  // at PICK time rather than captured when the toggle was pressed — the
  // artifact's content may have changed under it, and re-arming on every
  // keystroke would tear the highlight down mid-gesture.
  const artifactRef = useRef(artifact)
  const sendNowRef = useRef(sendNow)
  useEffect(() => {
    artifactRef.current = artifact
    sendNowRef.current = sendNow
  })

  const handlePick = useCallback(
    (element: ElementSelectionCore, modifiers: ArtifactPickModifiers) => {
      const current = artifactRef.current
      if (!current) return
      const snapshot = element.outerHTML || element.text
      if (modifiers.metaKey || modifiers.ctrlKey) {
        void sendNowRef.current?.(element, current)
        return
      }
      addContextSelection({
        kind: "artifact",
        artifactId: current.id,
        title: current.title,
        snapshot,
        comment: "",
        range: locateElementRange(current.content, element),
        element,
      })
      setPickedCount((count) => count + 1)
      toast.success(
        t("staged", {
          element: element.componentName ? `<${element.componentName}>` : element.tagName,
        })
      )
    },
    [addContextSelection, t]
  )

  // Arming is an effect, not a click handler, so the picker survives a preview
  // remount: `hasPicker` flips when the registry entry is replaced, and this
  // re-runs against the new controller.
  useEffect(() => {
    if (!artifactId || !selectMode) return undefined
    armArtifactPicker(artifactId, {
      originLabel: ARTIFACT_PICK_ORIGIN,
      onPick: handlePick,
      // Escape inside the preview is the same gesture as pressing the toggle.
      onCancel: () => setSelectModeRequested(false),
    })
    return () => disarmArtifactPicker(artifactId)
  }, [artifactId, handlePick, selectMode])

  const toggleSelectMode = useCallback(() => {
    setSelectModeRequested((on) => !on)
  }, [])

  return { available, selectMode, toggleSelectMode, pickedCount }
}
