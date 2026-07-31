"use client"

/**
 * Free-text settings input that commits on blur / Enter instead of on every
 * keystroke.
 *
 * The keystroke-commit shape persists — and, for live-applied settings, pushes
 * downstream — every intermediate state of what the user is typing. For a CSS
 * font stack that means the terminal is briefly reconfigured with `"`, then
 * `"F`, then `"Fira Cod`… each an invalid family that resolves to a fallback,
 * so the terminal flickers through wrong fonts and the store takes one write
 * per character.
 *
 * Draft-locally, commit deliberately:
 *   * Enter commits and keeps focus,
 *   * blur commits,
 *   * Escape abandons the draft and restores the committed value.
 *
 * `value` is re-seeded whenever it changes identity, so external writes (a
 * preset button, a picker, a reset) still win over a stale draft.
 */

import { useState, type ComponentProps } from "react"

import { Input } from "@/components/ui/input"

export interface DeferredTextInputProps extends Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange"
> {
  /** Committed value from the settings store. */
  value: string
  /** Called with the trimmed draft when it differs from `value`. */
  onCommit: (next: string) => void
}

export function DeferredTextInput({
  value,
  onCommit,
  onBlur,
  onKeyDown,
  ...rest
}: DeferredTextInputProps) {
  const [seed, setSeed] = useState(value)
  const [draft, setDraft] = useState(value)
  // Derived-state-from-props — see ClampedNumberInput for the same pattern.
  if (seed !== value) {
    setSeed(value)
    setDraft(value)
  }

  function commitDraft(): void {
    const next = draft.trim()
    if (next !== draft) setDraft(next)
    if (next !== value) onCommit(next)
  }

  return (
    <Input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        commitDraft()
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commitDraft()
        } else if (e.key === "Escape") {
          setDraft(value)
        }
        onKeyDown?.(e)
      }}
    />
  )
}

export default DeferredTextInput
