"use client"

// Tiny mock chat surface that previews how a `ThemeColors` object will look.
// Used by the custom-theme tab — the user edits tokens in `ColorTokenRow`
// and watches this preview update live, before persisting the theme. We
// don't read CSS variables here; the colors are passed in directly so
// previews work without applying the theme to the document.

import type { ThemeColors } from "@/types/plugin/plugin"

export interface ThemePreviewProps {
  colors: Partial<ThemeColors>
  fallback: ThemeColors
  /** Optional message to render in the assistant bubble (i18n hook). */
  assistantText?: string
  /** Optional message to render in the user bubble. */
  userText?: string
}

export function ThemePreview({ colors, fallback, assistantText, userText }: ThemePreviewProps) {
  const merged = { ...fallback, ...colors }
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border p-3 text-sm"
      style={{
        background: merged.background,
        color: merged.foreground,
        borderColor: merged.border,
      }}
      data-testid="theme-preview"
    >
      <div
        className="flex items-center justify-between border-b pb-2"
        style={{ borderColor: merged.border }}
      >
        <span style={{ color: merged.mutedForeground }}>chat / preview</span>
        <button
          type="button"
          tabIndex={-1}
          className="rounded px-2 py-1 text-xs"
          style={{ background: merged.primary, color: merged.primaryForeground }}
        >
          Send
        </button>
      </div>
      <div
        className="self-start rounded-lg px-2 py-1 text-xs"
        style={{ background: merged.muted, color: merged.foreground }}
      >
        {assistantText ?? "Hello — this is the assistant bubble."}
      </div>
      <div
        className="self-end rounded-lg px-2 py-1 text-xs"
        style={{ background: merged.accent, color: merged.accentForeground }}
      >
        {userText ?? "And this is the user bubble."}
      </div>
      <div
        className="rounded px-2 py-1 text-[11px]"
        style={{
          background: merged.card,
          color: merged.cardForeground,
          borderColor: merged.border,
        }}
      >
        Card surface · ring color shows here:
        <span
          className="ml-1 inline-block size-2.5 rounded-full"
          style={{ background: merged.ring }}
        />
      </div>
      <div
        className="rounded px-2 py-1 text-[11px]"
        style={{ background: merged.destructive, color: merged.destructiveForeground }}
      >
        Destructive action
      </div>
    </div>
  )
}
