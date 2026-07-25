"use client"

/**
 * Live specimen of the configured terminal typography.
 *
 * The integrated terminal applies font settings to already-open tabs, but the
 * settings page is a different surface — a user changing the font here has no
 * way to tell a setting that didn't apply from a font that silently fell back
 * to the next entry in the stack. Both read as "my setting did nothing".
 *
 * This renders the exact resolved stack (including the same default stack the
 * terminal falls back to) at the configured size / weight / line height /
 * letter spacing, over the selected scheme's own background, and says so
 * explicitly when the requested family isn't installed on this machine.
 *
 * The sample line deliberately mixes ASCII, box-drawing and Powerline glyphs —
 * the characters that actually go wrong when a Nerd Font isn't resolving.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { isFontFamilyAvailable, primaryFamilyOf } from "@/lib/appearance/font-availability"
import { resolveTerminalTheme } from "@/lib/terminal/color-schemes"
import { cn } from "@/lib/utils"

/**
 * Mirrors `DEFAULT_FONT_FAMILY` in `components/terminal/terminal-instance.tsx`:
 * what an empty `fontFamily` setting actually renders as.
 */
export const TERMINAL_DEFAULT_FONT_STACK =
  '"MesloLGS NF", "JetBrains Mono", "Cascadia Code", "Menlo", "Consolas", monospace'

/* i18n-exempt: glyph specimen — the point is the shapes, not the words. */
const SAMPLE_LINES = ["~/project $ ls -la  ┌─┤ ✔ ✚ ➜ ⌥ ⎇ ├─┐", "0O1lI  {} [] () <> => != ->"]

export interface TerminalFontPreviewProps {
  /** Configured stack; empty / undefined renders the terminal's default stack. */
  fontFamily?: string
  fontSize: number
  fontWeight?: string
  lineHeight?: number
  letterSpacing?: number
  /** Terminal color scheme id; `"auto"` / undefined follows the app theme. */
  colorScheme?: string
  className?: string
}

export function TerminalFontPreview({
  fontFamily,
  fontSize,
  fontWeight = "normal",
  lineHeight = 1,
  letterSpacing = 0,
  colorScheme,
  className,
}: TerminalFontPreviewProps) {
  const t = useTranslations("settings.terminal.fontPreview")
  const stack = fontFamily?.trim() ? fontFamily : TERMINAL_DEFAULT_FONT_STACK
  const requested = primaryFamilyOf(stack)

  // Probing measures text, so it has to run after paint — and re-run whenever
  // the requested family changes (including a webfont finishing its load).
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    const probe = () => {
      if (!cancelled) setAvailable(isFontFamilyAvailable(requested))
    }
    probe()
    // A bundled `@font-face` (MesloLGS NF) can still be in flight on first
    // paint; re-probe once the document's fonts settle so a loading font is
    // never reported as missing.
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    void Promise.resolve(fonts?.ready)
      .then(probe)
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [requested])

  const isDark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  const theme = resolveTerminalTheme(colorScheme, isDark)

  return (
    <div className={cn("space-y-1.5", className)} data-testid="terminal-font-preview">
      <p className="text-[11px] text-muted-foreground">{t("label")}</p>
      <div
        className="overflow-x-auto rounded border px-3 py-2"
        style={{ backgroundColor: theme.background, color: theme.foreground }}
      >
        <pre
          className="m-0 whitespace-pre"
          style={{
            fontFamily: stack,
            fontSize: `${fontSize}px`,
            fontWeight,
            lineHeight,
            letterSpacing: `${letterSpacing}px`,
          }}
          data-testid="terminal-font-preview-sample"
        >
          {SAMPLE_LINES.join("\n")}
        </pre>
      </div>
      {available === false ? (
        <p className="text-[11px] text-destructive" data-testid="terminal-font-preview-missing">
          {t("missing", { family: requested })}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {t("resolved", { family: requested, size: fontSize })}
        </p>
      )}
    </div>
  )
}

export default TerminalFontPreview
