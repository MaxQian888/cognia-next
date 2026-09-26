"use client"

/**
 * A local draft of one persisted setting, written once per gesture.
 *
 * Every settings save funnels through `saveSettings`, which on a mirrored
 * client (a paired phone, or a browser paired to a cloud host) also enqueues
 * one `app_settings_update` job per call for the host-writable keys
 * (`lib/settings/mirror-to-host.ts`). A control that saves on every change — a
 * text field, a slider dragged along its track, a native colour picker —
 * therefore queues a job per keystroke or per drag frame, and the host applies
 * each intermediate value in turn: typing "claude-opus" set the desktop's
 * default model to "c", "cl", "cla", … on the way.
 *
 * This keeps the in-progress value local and writes it once:
 *   - a text field on blur, or on Enter via `commitOnEnter` (which ignores the
 *     Enter an input method uses to confirm a candidate);
 *   - a slider on Radix's `onValueCommit` (pointer up, or one keyboard step),
 *     through `commitValue`;
 *   - on unmount, when a draft is still unsent, so leaving the page does not
 *     drop an edit that never blurred.
 *
 * `normalize` maps the raw draft to the value to persist (trim, parse, clamp)
 * and returns `null` to reject it, which reverts the field. A value equal to
 * the persisted one is not written. A sent draft is released only after its
 * write lands: the settings store updates after the Dexie round-trip, so
 * releasing earlier would flash the old value. It stays held if the user has
 * typed on since. With no draft held the field shows the persisted value, so a
 * sync-down from the host still shows; while one is held, the user's edit wins.
 *
 * Why not `useDraftField` (same folder): it commits after 400 ms of idle
 * typing, which on a mirrored client is still one queued job per pause, each
 * carrying a partial value; it is string-only; and its Enter does not check IME
 * composition. `useDirtyDraft` is a form-level draft behind a Save button.
 */

import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import { isImeComposing } from "@/lib/ui/ime"

export type SettingDraftValue = string | number

export interface SettingDraftOptions<T extends SettingDraftValue> {
  /** Map the raw draft to the value to persist; `null` rejects it (the field reverts). */
  normalize?: (draft: T) => T | null
  /** Equality against the persisted value. Defaults to `Object.is`. */
  equals?: (a: T, b: T) => boolean
}

export interface SettingDraft<T extends SettingDraftValue> {
  /** What the control renders: the held draft, else the persisted value. */
  value: T
  /** Hold a new draft without writing (bind to `onChange` / `onValueChange`). */
  set: (next: T) => void
  /** Write the held draft, if there is one not yet sent (bind to `onBlur`). */
  commit: () => void
  /** Write this value (bind to a slider's `onValueCommit`). */
  commitValue: (next: T) => void
  /** Abandon an unsent draft and show the persisted value again (Escape). */
  discard: () => void
  /** Bind to a single-line field's `onKeyDown`: Enter commits, IME-safe. */
  commitOnEnter: (event: ReactKeyboardEvent<HTMLElement>) => void
}

interface HeldDraft<T> {
  value: T
  /** Its write has been issued; released once every write in flight lands. */
  sent: boolean
}

export function useSettingDraft<T extends SettingDraftValue>(
  persisted: T,
  save: (next: T) => unknown,
  options: SettingDraftOptions<T> = {}
): SettingDraft<T> {
  const { normalize, equals = Object.is } = options
  const [held, setHeld] = useState<HeldDraft<T> | null>(null)
  // Writes issued and not yet landed. While any is in flight `persisted` is
  // about to change, so "equal to persisted" no longer means "nothing to do":
  // dragging 1 → 1.5 and straight back to 1 must still write the 1.
  const inFlightRef = useRef(0)

  const write = (raw: T) => {
    const next = normalize ? normalize(raw) : raw
    if (next === null || (inFlightRef.current === 0 && equals(next, persisted))) {
      setHeld(null)
      return
    }
    inFlightRef.current += 1
    setHeld({ value: raw, sent: true })
    void Promise.resolve(save(next)).finally(() => {
      inFlightRef.current -= 1
      if (inFlightRef.current > 0) return
      setHeld((current) => (current !== null && current.sent ? null : current))
    })
  }

  const commit = () => {
    if (held === null || held.sent) return
    write(held.value)
  }

  // Unmount with an unsent draft: write it rather than lose it. The ref is
  // refreshed after every render (never during one) so the cleanup sees the
  // last draft and the `save` / `persisted` it was typed against.
  const unsentRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    unsentRef.current = held !== null && !held.sent ? () => write(held.value) : null
  })
  useEffect(() => () => unsentRef.current?.(), [])

  return {
    value: held === null ? persisted : held.value,
    set: (next) => setHeld({ value: next, sent: false }),
    commit,
    commitValue: write,
    discard: () => setHeld((current) => (current !== null && !current.sent ? null : current)),
    commitOnEnter: (event) => {
      if (event.key !== "Enter" || isImeComposing(event)) return
      event.preventDefault()
      commit()
    },
  }
}
