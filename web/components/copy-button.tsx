"use client"

import { useEffect, useState } from "react"
import { Icon } from "@web/components/icon"
import { Button } from "@web/components/ui/button"
import { useHasMounted } from "@web/hooks/use-has-mounted"

interface CopyButtonProps {
  value: string
  copyLabel: string
  copiedLabel: string
}

/**
 * Copy a build command to the clipboard.
 *
 * The download page asks the reader to run three commands by hand, which is the
 * one place on this site where an interaction is unambiguously wanted rather
 * than decorative.
 *
 * Renders nothing until mounted. `navigator.clipboard` does not exist during
 * the static export, and rendering an enabled control on the server that cannot
 * work on the first client frame is worse than rendering it a frame late — the
 * command itself is selectable either way, so nothing is lost without
 * JavaScript.
 */
export function CopyButton({ value, copyLabel, copiedLabel }: CopyButtonProps) {
  const mounted = useHasMounted()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  if (!mounted || typeof navigator === "undefined" || !navigator.clipboard) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      // `aria-live` on the label rather than a toast: the state change is the
      // whole feedback, and it should reach a screen reader without stealing
      // focus.
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false)
        )
      }}
    >
      <Icon name={copied ? "check" : "record"} size={14} />
      <span aria-live="polite">{copied ? copiedLabel : copyLabel}</span>
    </Button>
  )
}
