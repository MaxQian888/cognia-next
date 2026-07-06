"use client"

// A compact sample UI shown inside the Appearance settings section. It renders
// representative surfaces — buttons in every variant, an input, a switch, chat
// bubbles, a card, a small table, and a code line — using the same design
// tokens the rest of the app consumes. Because everything styles through the
// live CSS variables (`--primary`, `--radius`, the `data-density` attributes,
// the font vars), it reflects the *currently applied* theme, color preset,
// density, corner radius, typography, and component radius without reading any
// settings itself. Editing any appearance control updates it instantly.

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

export interface AppearancePreviewProps {
  className?: string
}

export function AppearancePreview({ className }: AppearancePreviewProps) {
  const t = useTranslations("settings.appearance.preview")
  return (
    <div
      data-testid="appearance-preview"
      className={cn(
        "space-y-3 rounded-xl border bg-card p-3 text-card-foreground shadow-sm",
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
    </div>
  )
}
