"use client"

/**
 * Absolute-path field with a native directory picker.
 *
 * The common layout for the pairing every path field needs: a text input that
 * is the real control on every shell, plus a Browse shortcut only where a
 * picker exists. Rendering a Browse button that silently does nothing on web
 * is the failure mode this avoids.
 *
 * The decision behind that gate lives in `useDirectoryPicker`, shared with the
 * surfaces whose layout is a compact icon button rather than this one. Read
 * that hook for why there is no remote-host fallback.
 *
 * Labels are props rather than a namespace lookup so each caller keeps its own
 * i18n keys. The component never owns user-facing text.
 */

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDirectoryPicker } from "@/hooks/files/use-directory-picker"

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
  pick,
  hasPicker,
}: DirectoryFieldProps) {
  const picker = useDirectoryPicker({
    ...(pick ? { pick } : {}),
    ...(hasPicker ? { hasPicker } : {}),
  })

  async function browse() {
    const picked = await picker.browse()
    if (!picked) return // cancelled, or no picker on this shell
    onChange(picked)
    onCommit(picked)
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
      {picker.available && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled || picker.busy}
          onClick={() => void browse()}
        >
          {browseLabel}
        </Button>
      )}
    </div>
  )
}
