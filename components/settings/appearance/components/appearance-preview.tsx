"use client"

// A compact sample UI shown inside the Appearance settings section. It renders
// representative surfaces — buttons in every variant, an input, a switch, chat
// bubbles, a card, a small table, and a code line — using the same design
// tokens the rest of the app consumes. Because everything styles through the
// live CSS variables (`--primary`, `--radius`, the `data-density` attributes,
// the font vars), it reflects the *currently applied* theme, color preset,
// density, corner radius, typography, and component radius without reading any
// settings itself. Editing any appearance control updates it instantly.
//
// Passing `colors` overrides that: the tokens are written onto this element as
// scoped CSS custom properties, so the same markup previews a theme that is not
// applied to the document (the custom-theme editor's unsaved draft). Two rules
// callers must respect:
//
//   1. Pass a *complete* `ThemeColors`, never a sparse object. Unset variables
//      cascade from `<html>`, so a dark draft under a light app would render
//      half-light. The type enforces this; merge over a fallback at the call
//      site.
//   2. Pass `isDark` alongside. `globals.css` declares
//      `@custom-variant dark (&:is(.dark *))` — a *descendant* selector — and
//      the shadcn primitives below carry `dark:` variants (`input.tsx`'s
//      `dark:bg-input/30`, `switch.tsx`'s `dark:data-[state=unchecked]:bg-input/80`,
//      `button.tsx`'s `dark:bg-destructive/60`, …). Without the class a dark
//      draft renders light-mode variants painted with dark tokens.
//
// The vars and the `dark` class go on the root rather than a wrapper: an
// element's own custom properties are visible to its own declarations (so the
// root's `bg-card` resolves against the override), and the root itself carries
// no `dark:` variant — every one of those lives on a descendant, which is
// exactly what `.dark *` matches.

import { useMemo, type CSSProperties } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { THEME_COLOR_KEYS } from "@/lib/appearance"
import { themeKeyToCssVar } from "@/lib/appearance/css-var"
import { cn } from "@/lib/utils"
import type { ThemeColors } from "@/types/plugin/plugin"

export interface AppearancePreviewProps {
  className?: string
  /**
   * Render these tokens instead of the applied theme. Must be complete — see
   * the note above. Omit to preview whatever is currently applied.
   */
  colors?: ThemeColors
  /** Whether `colors` describes a dark theme. Ignored unless `colors` is set. */
  isDark?: boolean
}

export function AppearancePreview({ className, colors, isDark }: AppearancePreviewProps) {
  const t = useTranslations("settings.appearance.preview")
  // Iterate the allow-list rather than `Object.entries(colors)`: drafts can come
  // from `importThemeFromJson`, so an unknown key would otherwise be written
  // into the style object verbatim.
  const overrideStyle = useMemo(() => {
    if (!colors) return undefined
    const vars: Record<string, string> = {}
    for (const key of THEME_COLOR_KEYS) {
      const value = colors[key]
      if (typeof value === "string" && value !== "") vars[themeKeyToCssVar(key)] = value
    }
    // CSSProperties has no index signature for `--*`; React forwards such keys
    // to setProperty untouched.
    return vars as CSSProperties
  }, [colors])
  return (
    <div
      data-testid="appearance-preview"
      style={overrideStyle}
      className={cn(
        "space-y-3 rounded-xl border bg-card p-3 text-card-foreground shadow-sm",
        colors && isDark && "dark",
        className
      )}
    >
      {/* Window chrome — shows border, foreground, and the accent dot palette. */}
      <div className="flex items-center gap-2 border-b pb-2">
        <span className="flex gap-1" aria-hidden>
          <span className="size-2 rounded-full bg-destructive/70" />
          <span className="size-2 rounded-full bg-primary/40" />
          <span className="size-2 rounded-full bg-primary/70" />
        </span>
        <span className="truncate text-xs font-medium">{t("windowTitle")}</span>
        <Badge variant="secondary" className="ml-auto text-[10px]">
          {t("badge")}
        </Badge>
      </div>

      {/* Button variants — primary / secondary / outline / ghost / destructive. */}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" className="h-7 text-xs" tabIndex={-1}>
          {t("buttons.primary")}
        </Button>
        <Button size="sm" variant="secondary" className="h-7 text-xs" tabIndex={-1}>
          {t("buttons.secondary")}
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" tabIndex={-1}>
          {t("buttons.outline")}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" tabIndex={-1}>
          {t("buttons.ghost")}
        </Button>
        <Button size="sm" variant="destructive" className="h-7 text-xs" tabIndex={-1}>
          {t("buttons.destructive")}
        </Button>
      </div>

      {/* Input + switch — shows input surface, focus ring token, and primary. */}
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={t("inputSample")}
          aria-label={t("inputAria")}
          tabIndex={-1}
          className="h-7 flex-1 text-xs"
        />
        <Switch
          checked
          onCheckedChange={() => {}}
          aria-label={t("switchAria")}
          tabIndex={-1}
          className="pointer-events-none"
        />
      </div>

      {/* Chat bubbles — the muted assistant + primary user pairing. */}
      <div className="space-y-1.5">
        <div className="max-w-[85%] rounded-lg bg-muted px-2.5 py-1.5 text-xs text-foreground">
          {t("assistant")}
        </div>
        <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-2.5 py-1.5 text-xs text-primary-foreground">
          {t("user")}
        </div>
      </div>

      {/* Mini table — header + two rows show borders and muted surfaces. */}
      <div className="overflow-hidden rounded-md border text-[11px]">
        <div className="flex bg-muted/50 font-medium text-muted-foreground">
          <span className="flex-1 px-2 py-1">{t("table.col1")}</span>
          <span className="w-16 px-2 py-1 text-right">{t("table.col2")}</span>
        </div>
        <div className="flex border-t">
          <span className="flex-1 px-2 py-1">{t("table.row1")}</span>
          <span className="w-16 px-2 py-1 text-right font-mono">42</span>
        </div>
        <div className="flex border-t">
          <span className="flex-1 px-2 py-1">{t("table.row2")}</span>
          <span className="w-16 px-2 py-1 text-right font-mono">128</span>
        </div>
      </div>

      {/* Code line — surfaces the monospace font family + muted surface. */}
      <pre className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
        <code>{t("code")}</code>
      </pre>

      {/* Draft-only swatch strip. The surfaces above never paint `accent`,
          `ring`, or `popover` statically — accent shows on hover, ring on
          focus-visible (and every control here is tabIndex={-1}), popover not
          at all. Without this, editing those five tokens in the custom-theme
          editor would look inert. Not rendered in applied-theme mode: there is
          nothing to compare against, and the surfaces above already carry the
          tokens that matter. */}
      {colors && <TokenSwatchStrip />}
    </div>
  )
}

const SWATCH_TOKENS = [
  { key: "accent", className: "bg-accent" },
  { key: "accentForeground", className: "bg-accent-foreground" },
  { key: "ring", className: "bg-ring" },
  { key: "popover", className: "bg-popover" },
  { key: "popoverForeground", className: "bg-popover-foreground" },
] as const

function TokenSwatchStrip() {
  const t = useTranslations("settings.appearance.preview")
  // Reuse the custom-theme editor's token names rather than minting parallel
  // copies — these are the same tokens the TokenGroup rows label.
  const tokenT = useTranslations("settings.appearance.customTheme.tokens")
  return (
    <div className="space-y-1" data-testid="appearance-preview-swatches">
      <p className="text-[10px] text-muted-foreground">{t("tokensLabel")}</p>
      <div className="flex flex-wrap gap-1.5">
        {SWATCH_TOKENS.map(({ key, className }) => (
          <span
            key={key}
            title={tokenT(key)}
            aria-label={tokenT(key)}
            data-testid={`appearance-preview-swatch-${key}`}
            className={cn("size-4 rounded border", className)}
          />
        ))}
      </div>
    </div>
  )
}
