"use client"

import { useMemo, useRef } from "react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"

/**
 * A stable handle on the composer's text that always reads the LATEST value.
 *
 * `PromptInputProvider` rebuilds its `textInput` object on every keystroke —
 * the value is one of its fields. The composer used that object as a
 * dependency of every callback and effect that touches the text: `submit`,
 * `onKeyDown`, the popover pick, the imperative handle, the draft hydration,
 * the template re-run subscription, the attachment intake. So each keystroke
 * rebuilt ~15 callbacks, re-subscribed a window listener, re-ran the draft
 * hydration and handed every memoized child a new prop.
 *
 * This handle has the same shape but keeps one identity for the composer's
 * lifetime, so a callback depending on it is rebuilt only by its other
 * inputs. Its `value` getter reads the latest committed text — refreshed in a
 * layout effect, before any passive effect or event handler of the commit can
 * observe it — and a write through it is readable immediately, so
 * `setInput(next)` followed by `.value` in the same handler sees `next`.
 *
 * Not for render: during a render the getter still holds the previous
 * commit's text. Render-time reads (memos over the draft, JSX) keep using the
 * provider's `value` directly, which is what re-renders them.
 */
export function useLatestTextInput(textInput: TextInputContext): TextInputContext {
  const latest = useRef(textInput.value)
  useIsomorphicLayoutEffect(() => {
    latest.current = textInput.value
  }, [textInput.value])

  const { setInput, clear } = textInput
  return useMemo<TextInputContext>(
    () => ({
      get value() {
        return latest.current
      },
      setInput: (next: string) => {
        latest.current = next
        setInput(next)
      },
      clear: () => {
        latest.current = ""
        clear()
      },
    }),
    [setInput, clear]
  )
}
