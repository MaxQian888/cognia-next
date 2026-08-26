"use client"

// Composer-side wiring for folded links (`lib/chat/link-fold.ts`).
//
// Holds the label → URL map, folds URLs as the caret leaves them, and owns the
// two places the full URL has to come back: the clipboard and the outgoing
// message. Everything about WHICH label a URL gets lives in `link-display.ts`;
// everything about the fold itself is pure and lives in `link-fold.ts`. This
// hook is only the plumbing between them and the textarea.

import { useCallback, useMemo, useState, type ClipboardEvent, type RefObject } from "react"
import { describeLink, type LinkDisplaySettings } from "@/lib/chat/link-display"
import {
  expandFoldedLinks,
  foldLinks,
  foldedLinkSpans,
  isFoldedLink,
  type FoldedLinks,
} from "@/lib/chat/link-fold"

export interface UseLinkFoldingOptions {
  value: string
  setInput: (next: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setCaret: (caret: number) => void
  /** `composerBehavior.linkChips` — the label rules the user picked. */
  display?: LinkDisplaySettings
}

export interface LinkFolding {
  /** Label → full URL for everything folded in the current text. */
  links: FoldedLinks
  /** Replace the map wholesale (draft restore, session switch, post-send clear). */
  setLinks: (next: FoldedLinks) => void
  /** Where the labels sit, for the chip overlay. */
  spans: ReturnType<typeof foldedLinkSpans>
  /** Is this whitespace-delimited token one of our labels? */
  isFoldedToken: (token: string) => boolean
  /**
   * Fold the URLs the caret has left behind. Call after the text changes with
   * the live caret, or with `-1` (blur) to fold everything. Paste is NOT one of
   * the `-1` callers: the caret lands at the end of what was pasted, so a
   * pasted URL settles on the next keystroke past it, or on blur.
   */
  fold: (text: string, caret: number) => void
  onCopy: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onCut: (event: ClipboardEvent<HTMLTextAreaElement>) => void
}

export function useLinkFolding(opts: UseLinkFoldingOptions): LinkFolding {
  const { value, setInput, textareaRef, setCaret, display } = opts
  const [links, setLinks] = useState<FoldedLinks>({})

  const label = useCallback((url: string) => describeLink(url, display).label, [display])

  const fold = useCallback(
    (text: string, caret: number) => {
      const result = foldLinks(text, { caret, links, label })
      if (!result.changed) {
        // Still drop entries whose token the user just deleted, so a label
        // retyped later is plain text rather than a resurrected link.
        if (Object.keys(result.links).length !== Object.keys(links).length) setLinks(result.links)
        return
      }
      setInput(result.text)
      setLinks(result.links)
      // A negative caret is the "fold everything, there is no live caret"
      // sentinel (blur, paste). There is nothing to restore, and forcing a
      // position would move a caret the user never asked to move.
      if (result.caret < 0) return
      setCaret(result.caret)
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta) ta.setSelectionRange(result.caret, result.caret)
      })
    },
    [links, label, setInput, setCaret, textareaRef]
  )

  const spans = useMemo(() => foldedLinkSpans(value, links), [value, links])

  // `isFoldedLink`, never `token in links`: `in` walks `Object.prototype`, so a
  // message containing the word `constructor` or `toString` would be parsed as
  // a link token (making `constructor /clear` run the command) while the
  // overlay, which resolves spans by own key, painted nothing.
  const isFoldedToken = useCallback((token: string) => isFoldedLink(links, token), [links])

  /** The selected text with any whole folded label inside it expanded. */
  const expandedSelection = useCallback(
    (ta: HTMLTextAreaElement): { text: string; start: number; end: number } | null => {
      const start = ta.selectionStart ?? 0
      const end = ta.selectionEnd ?? 0
      if (start === end) return null
      const selected = ta.value.slice(start, end)
      return { text: expandFoldedLinks(selected, links), start, end }
    },
    [links]
  )

  const onCopy = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const ta = event.currentTarget
      const selection = expandedSelection(ta)
      if (!selection) return
      if (selection.text === ta.value.slice(selection.start, selection.end)) return
      // Copying a link has to yield the link. The label is what the box shows;
      // it is not what anyone means to paste elsewhere.
      event.clipboardData.setData("text/plain", selection.text)
      event.preventDefault()
    },
    [expandedSelection]
  )

  const onCut = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const ta = event.currentTarget
      const selection = expandedSelection(ta)
      if (!selection) return
      if (selection.text === ta.value.slice(selection.start, selection.end)) return
      event.clipboardData.setData("text/plain", selection.text)
      event.preventDefault()
      // preventDefault also cancels the browser's own removal, so do it here.
      const next = ta.value.slice(0, selection.start) + ta.value.slice(selection.end)
      setInput(next)
      setCaret(selection.start)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) el.setSelectionRange(selection.start, selection.start)
      })
    },
    [expandedSelection, setInput, setCaret, textareaRef]
  )

  // Memoised, and that is load-bearing rather than a micro-optimisation: the
  // composer derives `isLinkToken` from this object, and `isLinkToken` is a
  // dependency of the `parseSegments` memo, the overlay-segment memo and the
  // trigger memo. A fresh literal every render re-tokenised the entire input
  // on every caret move, popover change and streamed token, and defeated
  // `ComposerChipOverlay`'s own `memo` along the way.
  return useMemo(
    () => ({ links, setLinks, spans, isFoldedToken, fold, onCopy, onCut }),
    [links, spans, isFoldedToken, fold, onCopy, onCut]
  )
}
