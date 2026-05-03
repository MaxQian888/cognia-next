"use client"

// Build a 2-stop linear gradient from two colors + an angle. Outputs a CSS
// gradient string the parent can drop straight into a `Wallpaper.source`.
// We deliberately keep this minimal — multi-stop / radial / mesh gradients
// land in the next iteration if users ask for them.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { ColorTokenRow } from "./color-token-row"

export interface GradientStops {
  start: string
  end: string
  angle: number
}

export interface GradientBuilderProps {
  /** Optional initial stops; defaults to a tasteful blue/purple combo. */
  initial?: Partial<GradientStops>
  /** Called when the user clicks "Add to gallery" with a final CSS string. */
  onCreate: (css: string, name: string) => Promise<void> | void
}

const DEFAULTS: GradientStops = { start: "#667eea", end: "#764ba2", angle: 135 }

/** Build a CSS gradient string from the stops. Exported for tests. */
export function buildGradientCss({ start, end, angle }: GradientStops): string {
  const safeAngle = Math.max(0, Math.min(360, Math.round(angle)))
  return `linear-gradient(${safeAngle}deg, ${start} 0%, ${end} 100%)`
}

export function GradientBuilder({ initial, onCreate }: GradientBuilderProps) {
  const t = useTranslations("settings.appearance.wallpaper.gradient")
  // `initial` seeds the first render only — to remix a preset the caller
  // remounts via a `key` prop. This avoids the setState-in-effect dance
  // and matches React 19's recommended state-from-prop pattern.
  const [stops, setStops] = useState<GradientStops>({ ...DEFAULTS, ...initial })
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)

  const css = buildGradientCss(stops)

  const handleCreate = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await onCreate(css, name.trim())
      setName("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div
        className="aspect-video w-full rounded-md border"
        style={{ backgroundImage: css, backgroundSize: "cover" }}
        data-testid="gradient-preview"
      />

      <ColorTokenRow
        tokenKey="gradient-start"
        label={t("start")}
        value={stops.start}
        onChange={(start) => setStops((s) => ({ ...s, start }))}
      />
      <ColorTokenRow
        tokenKey="gradient-end"
        label={t("end")}
        value={stops.end}
        onChange={(end) => setStops((s) => ({ ...s, end }))}
      />

      <div className="space-y-1">
        <Label className="text-[11px] uppercase tracking-wide">{t("angle")}</Label>
        <div className="flex items-center gap-2">
          <Slider
            value={[stops.angle]}
            min={0}
            max={360}
            step={1}
            onValueChange={(v) => setStops((s) => ({ ...s, angle: v[0] ?? 0 }))}
            className="flex-1"
            aria-label={t("angle")}
          />
          <span className="w-12 text-right font-mono text-[11px] text-muted-foreground">
            {stops.angle}°
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          placeholder={t("namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 flex-1"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void handleCreate()}
          disabled={!name.trim() || busy}
        >
          {t("save")}
        </Button>
      </div>
    </div>
  )
}
