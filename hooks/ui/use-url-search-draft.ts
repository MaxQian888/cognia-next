"use client"

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type RefObject,
} from "react"

export interface UrlSearchDraftInputProps {
  ref: RefObject<HTMLInputElement | null>
  value: string
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void
}

/**
 * Props for a search box whose query lives in the URL.
 *
 * Binding the input straight to the URL value does not work. Every keystroke
 * goes through `router.replace` and comes back a render later, so the input
 * is reset under the typist: an IME commits pinyin half-typed, and fast typing
 * drops characters. The box therefore shows its own draft.
 *
 * - The URL is written for final characters only: on every change outside an
 *   IME composition, and once at `compositionend` inside one. A filter on
 *   "ni" is not a query anyone asked for.
 * - The draft follows the URL only for changes the box did not make (a Clear
 *   filters button, a deep link), told apart by whether the box has focus.
 *   Comparing values instead cannot work: while the URL lags, "a" arriving
 *   after the user typed "ab" looks exactly like an outside change.
 */
export function useUrlSearchDraft(
  query: string,
  setQuery: (value: string) => void
): UrlSearchDraftInputProps {
  const ref = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState(query)
  useEffect(() => {
    if (document.activeElement === ref.current) return
    // Following a navigation this box did not make.
    setDraft(query)
  }, [query])
  return {
    ref,
    value: draft,
    onChange: (event) => {
      setDraft(event.target.value)
      if (!(event.nativeEvent as InputEvent).isComposing) setQuery(event.target.value)
    },
    onCompositionEnd: (event) => setQuery(event.currentTarget.value),
  }
}
