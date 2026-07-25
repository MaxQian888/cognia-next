"use client"

/**
 * Numeric settings input that clamps on *commit* instead of on every keystroke.
 *
 * The naive shape — `onChange={(e) => save(clamp(Number(e.target.value)))}` on a
 * store-controlled `<Input type="number">` — is unusable for any range whose
 * floor has more than one digit: each keystroke is clamped and written back, so
 * the field can never pass through the intermediate prefixes.
 *
 *   min 8 / max 32, user types "20" → "2" clamps up to 8 → field reads "8"
 *   min 1000,       user types "20000" → "2" clamps to 1000, then the appended
 *                   digits run past the ceiling → field reads "100000"
 *
 * That is the "I set the terminal font size and nothing happened" bug.
 *
 * Here the typed text lives in a local draft:
 *   * every keystroke updates the draft, so the field always shows what was
 *     typed;
 *   * a draft that already parses inside `[min, max]` commits immediately, so
 *     live-preview settings (terminal font size) still apply as you type;
 *   * blur / Enter commits the clamped value — the only place clamping happens;
 *   * an empty or unparseable draft reverts to the committed value on blur
 *     (blanking a field is not a request to jump to the minimum);
 *   * Escape abandons the draft.
 *
 * The draft re-seeds whenever the committed `value` changes identity, which
 * covers both our own commits (normalising "020" → "20") and external writes.
 */

import { useState, type ComponentProps } from "react"

import { Input } from "@/components/ui/input"

export interface ClampedNumberInputProps extends Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "type" | "min" | "max"
> {
  /** Committed value from the settings store. */
  value: number
  min: number
  max: number
  /** Called with the clamped (and, when `integer`, rounded) value. */
  onCommit: (next: number) => void
  /** Round to a whole number before committing. Defaults to false. */
  integer?: boolean
}

/** Clamp + optionally round, mirroring what the committed value will be. */
export function clampNumber(raw: number, min: number, max: number, integer: boolean): number {
  const bounded = Math.max(min, Math.min(max, raw))
  return integer ? Math.round(bounded) : bounded
}

export function ClampedNumberInput({
  value,
  min,
  max,
  onCommit,
  integer = false,
  step,
  onBlur,
  onKeyDown,
  ...rest
}: ClampedNumberInputProps) {
  const [seed, setSeed] = useState(value)
  const [draft, setDraft] = useState(() => String(value))
  // Derived-state-from-props: re-seed the draft when the committed value moves
  // under us (our own normalised commit, a reset, or a cross-surface write).
  if (seed !== value) {
    setSeed(value)
    setDraft(String(value))
  }

  /** Commit `next` unless it already equals the stored value. */
  function commit(next: number): void {
    if (next !== value) onCommit(next)
  }

  function commitDraft(): void {
    const parsed = Number(draft)
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      // Nothing usable was typed — snap back to what is actually stored.
      setDraft(String(value))
      return
    }
    const next = clampNumber(parsed, min, max, integer)
    setDraft(String(next))
    commit(next)
  }

  return (
    <Input
      {...rest}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        const parsed = Number(raw)
        if (raw.trim() === "" || !Number.isFinite(parsed)) return
        // Only in-range drafts commit while typing; out-of-range prefixes wait
        // for blur so the clamp can't eat the keystrokes still to come.
        if (parsed < min || parsed > max) return
        commit(integer ? Math.round(parsed) : parsed)
      }}
      onBlur={(e) => {
        commitDraft()
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commitDraft()
        } else if (e.key === "Escape") {
          setDraft(String(value))
        }
        onKeyDown?.(e)
      }}
    />
  )
}

export default ClampedNumberInput
