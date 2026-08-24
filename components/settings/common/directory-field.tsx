"use client"

/**
 * Absolute-path field with a native directory picker.
 *
 * Six settings surfaces pair `pickDirectory()` with an `<Input>` by hand; this
 * is that pairing once, including the part everyone re-derives: the picker only
 * exists on the desktop shell (`pickDirectory` resolves to `null` off Tauri), so
 * the text input is the real control everywhere and the Browse button is the
 * shortcut. Rendering a Browse button that silently does nothing on web is the
 * failure mode this avoids.
 *
 * Labels are props rather than a namespace lookup so each caller keeps its own
 * i18n keys — the component never owns user-facing text.
 */

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { pickDirectory } from "@/lib/files/file-bridge"
import { isTauri } from "@/lib/tauri"

export interface DirectoryFieldProps {
  value: string
  onChange: (next: string) => void
  /** Persist. Fired on blur, and immediately after a successful pick. */
  onCommit: (next: string) => void
  placeholder?: string
  ariaLabel: string
  browseLabel: string
  disabled?: boolean
  /** Injected in tests; defaults to the native picker. */
  pick?: () => Promise<string | null>
  /** Injected in tests; defaults to the real shell check. */
  hasPicker?: () => boolean
}

export function DirectoryField({
  value,
  onChange,
  onCommit,
  placeholder,
  ariaLabel,
  browseLabel,
  disabled,
  pick = pickDirectory,
  hasPicker = isTauri,
}: DirectoryFieldProps) {
  const [browsing, setBrowsing] = useState(false)
  // Same gate `pickDirectory` itself applies, read here so the button is absent
  // rather than present-and-inert on web and mobile.
  const canBrowse = hasPicker()

  async function browse() {
    setBrowsing(true)
    try {
      const picked = await pick()
      if (!picked) return // cancelled
      onChange(picked)
      onCommit(picked)
    } finally {
      setBrowsing(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit(value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className="min-w-0 flex-1"
      />
      {canBrowse && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled || browsing}
          onClick={() => void browse()}
        >
          {browseLabel}
        </Button>
      )}
    </div>
  )
}
