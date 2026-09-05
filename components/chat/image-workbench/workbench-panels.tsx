"use client"

/**
 * The three tool panels: geometry, tone, and the model.
 *
 * They share a file because they share a shape and are only ever mounted by
 * `image-workbench.tsx`, one at a time. Each is a controlled surface: it holds
 * only its own draft (an in-progress crop rect, an unsent prompt) and hands
 * finished work up as an editor entry.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import {
  ASPECT_PRESETS,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  applyAspectToRect,
  largestRectForAspect,
  resolveResize,
  type CropRect,
  type ImageAdjustments,
} from "@/lib/images"
import type { ImageEditCapability } from "@/lib/chat/image-edit/ai-service"
import type { ImageWorkbenchAiState } from "@/hooks/chat/use-image-workbench"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

export interface TransformPanelProps {
  size: { width: number; height: number } | null
  cropRect: CropRect | null
  onCropRectChange: (rect: CropRect | null) => void
  aspectId: string
  onAspectChange: (aspectId: string) => void
  onApplyCrop: (rect: CropRect) => void
  onResize: (width: number, height: number) => void
  onRotate: (turns: number) => void
  onFlip: (axis: "horizontal" | "vertical") => void
  lockAspect: boolean
  onLockAspectChange: (locked: boolean) => void
}

export function TransformPanel({
  size,
  cropRect,
  onCropRectChange,
  aspectId,
  onAspectChange,
  onApplyCrop,
  onResize,
  onRotate,
  onFlip,
  lockAspect,
  onLockAspectChange,
}: TransformPanelProps) {
  const t = useTranslations("chat.imageWorkbench")

  // The size fields are a local draft committed by "Apply size", not a live
  // controlled value. Feeding every keystroke back through a parsed number
  // means clearing the field snaps it to 1 and the next digit lands after
  // that, so typing a new width produces something like 1400.
  const [draft, setDraft] = useState<{ width: string; height: string } | null>(null)
  const [syncedFrom, setSyncedFrom] = useState(size)
  if (size !== syncedFrom) {
    setSyncedFrom(size)
    setDraft(null)
  }
  const shown = draft ?? {
    width: size ? String(size.width) : "",
    height: size ? String(size.height) : "",
  }

  /** Retype one field, deriving the other when proportions are locked. */
  const editDimension = (edited: "width" | "height", raw: string) => {
    const next = { ...shown, [edited]: raw }
    const parsed = Number(raw)
    if (size && lockAspect && Number.isFinite(parsed) && parsed > 0) {
      const resolved = resolveResize(
        size,
        { [edited]: parsed } as Partial<{ width: number; height: number }>,
        { lockAspect, edited }
      )
      next.width = edited === "width" ? raw : String(resolved.width)
      next.height = edited === "height" ? raw : String(resolved.height)
    }
    setDraft(next)
  }

  const commitResize = () => {
    const width = Number(shown.width)
    const height = Number(shown.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return
    onResize(Math.round(width), Math.round(height))
    setDraft(null)
  }

  const selectAspect = (nextId: string) => {
    onAspectChange(nextId)
    if (!size) return
    const preset = ASPECT_PRESETS.find((entry) => entry.id === nextId)
    if (!preset) return
    if (preset.ratio === null) {
      onCropRectChange(cropRect)
      return
    }
    // Reshaping an existing selection keeps the user's framing. With nothing
    // selected yet the largest fitting rect is the useful starting point.
    onCropRectChange(
      cropRect
        ? applyAspectToRect(cropRect, preset.ratio, size)
        : largestRectForAspect(size, preset.ratio)
    )
  }

  return (
    <div className="flex flex-col gap-5" data-testid="workbench-transform-panel">
      <section className="flex flex-col gap-2">
        <Label className="text-xs uppercase tracking-wide text-white/60">{t("crop.title")}</Label>
        <ToggleGroup
          type="single"
          value={aspectId}
          onValueChange={(value) => value && selectAspect(value)}
          className="flex-wrap justify-start gap-1"
        >
          {ASPECT_PRESETS.map((preset) => (
            <ToggleGroupItem
              key={preset.id}
              value={preset.id}
              aria-label={t(`crop.aspect.${preset.id}`)}
              className="h-8 min-w-0 shrink px-2 text-xs"
            >
              {t(`crop.aspect.${preset.id}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!cropRect}
            onClick={() => cropRect && onApplyCrop(cropRect)}
          >
            {t("crop.apply")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!cropRect}
            onClick={() => onCropRectChange(null)}
          >
            {t("crop.clear")}
          </Button>
          {cropRect ? (
            <span className="text-xs tabular-nums text-white/60" data-testid="workbench-crop-size">
              {Math.round(cropRect.width)} x {Math.round(cropRect.height)}
            </span>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <Label className="text-xs uppercase tracking-wide text-white/60">{t("resize.title")}</Label>
        <div className="flex items-center gap-2">
          <Input
            aria-label={t("resize.width")}
            type="number"
            min={1}
            value={shown.width}
            onChange={(event) => editDimension("width", event.target.value)}
            className="h-8 w-24"
          />
          <span className="text-white/40">x</span>
          <Input
            aria-label={t("resize.height")}
            type="number"
            min={1}
            value={shown.height}
            onChange={(event) => editDimension("height", event.target.value)}
            className="h-8 w-24"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="workbench-lock-aspect"
            checked={lockAspect}
            onCheckedChange={onLockAspectChange}
          />
          <Label htmlFor="workbench-lock-aspect" className="text-xs text-white/70">
            {t("resize.lockAspect")}
          </Label>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            disabled={!size}
            onClick={commitResize}
          >
            {t("resize.apply")}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <Label className="text-xs uppercase tracking-wide text-white/60">
          {t("transform.title")}
        </Label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => onRotate(-1)}>
            {t("transform.rotateLeft")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onRotate(1)}>
            {t("transform.rotateRight")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onFlip("horizontal")}>
            {t("transform.flipHorizontal")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onFlip("vertical")}>
            {t("transform.flipVertical")}
          </Button>
        </div>
      </section>
    </div>
  )
}

/**
 * Slider definitions, in the order they are shown.
 *
 * A table rather than eleven blocks of markup, because every one of them
 * behaves identically and the differences are entirely data. Labels are looked
 * up as `adjust.<key>`, which `lint:i18n` cannot see through, so
 * `workbench-panels.test.tsx` asserts the whole catalogue is present.
 */
export const ADJUSTMENT_SLIDERS: ReadonlyArray<{
  key: keyof ImageAdjustments
  min: number
  max: number
  step: number
  neutral: number
}> = [
  { key: "exposure", min: -100, max: 100, step: 1, neutral: 0 },
  { key: "brightness", min: -100, max: 100, step: 1, neutral: 0 },
  { key: "contrast", min: -100, max: 100, step: 1, neutral: 0 },
  { key: "gamma", min: 0.2, max: 4, step: 0.05, neutral: 1 },
  { key: "temperature", min: -100, max: 100, step: 1, neutral: 0 },
  { key: "tint", min: -100, max: 100, step: 1, neutral: 0 },
  { key: "saturation", min: -100, max: 100, step: 1, neutral: 0 },
  { key: "vibrance", min: -100, max: 100, step: 1, neutral: 0 },
  { key: "hue", min: -180, max: 180, step: 1, neutral: 0 },
  { key: "blur", min: 0, max: 100, step: 1, neutral: 0 },
  { key: "sharpen", min: 0, max: 100, step: 1, neutral: 0 },
]

export interface AdjustPanelProps {
  adjustments: ImageAdjustments
  onChange: (adjustments: ImageAdjustments) => void
  onReset: () => void
}

export function AdjustPanel({ adjustments, onChange, onReset }: AdjustPanelProps) {
  const t = useTranslations("chat.imageWorkbench")
  return (
    <div className="flex flex-col gap-4" data-testid="workbench-adjust-panel">
      {ADJUSTMENT_SLIDERS.map((slider) => {
        const value = adjustments[slider.key] ?? slider.neutral
        return (
          <div key={slider.key} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <Label className="text-xs text-white/70">{t(`adjust.${slider.key}`)}</Label>
              <span className="text-xs tabular-nums text-white/50">
                {slider.step < 1 ? value.toFixed(2) : Math.round(value)}
              </span>
            </div>
            <Slider
              aria-label={t(`adjust.${slider.key}`)}
              min={slider.min}
              max={slider.max}
              step={slider.step}
              value={[value]}
              onValueChange={([next]) => onChange({ ...adjustments, [slider.key]: next })}
            />
          </div>
        )
      })}
      <Button size="sm" variant="ghost" onClick={onReset} className="self-start">
        {t("adjust.reset")}
      </Button>
    </div>
  )
}

export interface AiPanelProps {
  ai: ImageWorkbenchAiState
  prompt: string
  onPromptChange: (prompt: string) => void
  regionMode: boolean
  onRegionModeChange: (enabled: boolean) => void
  brush: { radius: number; hardness: number; mode: "add" | "subtract" }
  onBrushChange: (brush: { radius: number; hardness: number; mode: "add" | "subtract" }) => void
  hasSelection: boolean
  onClearSelection: () => void
  onRun: () => void
}

export function AiPanel({
  ai,
  prompt,
  onPromptChange,
  regionMode,
  onRegionModeChange,
  brush,
  onBrushChange,
  hasSelection,
  onClearSelection,
  onRun,
}: AiPanelProps) {
  const t = useTranslations("chat.imageWorkbench")
  const { capabilities, capability, running, error } = ai
  const maskSupported = capability?.supportsMask ?? false

  if (capabilities.options.length === 0) {
    const reason = capabilities.unavailable?.reason ?? "no-provider"
    return (
      <div className="flex flex-col gap-2" data-testid="workbench-ai-unavailable">
        <p className="text-sm text-white/80">{t(`ai.unavailable.${reason}`)}</p>
        {capabilities.unavailable?.detail ? (
          <p className="text-xs text-white/50">{capabilities.unavailable.detail}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-testid="workbench-ai-panel">
      <section className="flex flex-col gap-1.5">
        <Label className="text-xs uppercase tracking-wide text-white/60">{t("ai.provider")}</Label>
        <ToggleGroup
          type="single"
          value={capability?.providerId ?? ""}
          onValueChange={(value) => {
            const next = capabilities.options.find(
              (option: ImageEditCapability) => option.providerId === value
            )
            if (next) ai.selectCapability(next)
          }}
          className="flex-wrap justify-start gap-1"
        >
          {capabilities.options.map((option) => (
            <ToggleGroupItem
              key={option.providerId}
              value={option.providerId}
              className="h-8 min-w-0 shrink px-2 text-xs"
            >
              {option.providerId}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {capability ? (
          <p className="text-xs text-white/45" data-testid="workbench-ai-model">
            {t("ai.modelLine", { model: capability.modelId })}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="workbench-region-mode"
            checked={regionMode}
            disabled={!maskSupported}
            onCheckedChange={onRegionModeChange}
          />
          <Label htmlFor="workbench-region-mode" className="text-xs text-white/70">
            {t("ai.regionMode")}
          </Label>
        </div>
        {!maskSupported ? (
          // Disabled and explained, not hidden. Whole-image prompt editing
          // still works here, so removing the control would hide a capability
          // the provider does have.
          <p className="text-xs text-amber-300/80" data-testid="workbench-mask-unsupported">
            {t("ai.maskUnsupported", { provider: capability?.providerId ?? "" })}
          </p>
        ) : null}
      </section>

      {regionMode && maskSupported ? (
        <section className="flex flex-col gap-3" data-testid="workbench-brush-controls">
          <ToggleGroup
            type="single"
            value={brush.mode}
            onValueChange={(value) =>
              value && onBrushChange({ ...brush, mode: value as "add" | "subtract" })
            }
            className="justify-start gap-1"
          >
            <ToggleGroupItem value="add" className="h-8 px-2 text-xs">
              {t("ai.brushAdd")}
            </ToggleGroupItem>
            <ToggleGroupItem value="subtract" className="h-8 px-2 text-xs">
              {t("ai.brushSubtract")}
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-white/70">{t("ai.brushSize")}</Label>
            <Slider
              aria-label={t("ai.brushSize")}
              min={MIN_BRUSH_RADIUS}
              max={MAX_BRUSH_RADIUS}
              step={1}
              value={[brush.radius]}
              onValueChange={([radius]) => onBrushChange({ ...brush, radius })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-white/70">{t("ai.brushHardness")}</Label>
            <Slider
              aria-label={t("ai.brushHardness")}
              min={0}
              max={1}
              step={0.05}
              value={[brush.hardness]}
              onValueChange={([hardness]) => onBrushChange({ ...brush, hardness })}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasSelection}
            onClick={onClearSelection}
            className="self-start"
          >
            {t("ai.clearSelection")}
          </Button>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <Label htmlFor="workbench-prompt" className="text-xs uppercase tracking-wide text-white/60">
          {t("ai.promptLabel")}
        </Label>
        <Textarea
          id="workbench-prompt"
          rows={3}
          value={prompt}
          placeholder={t("ai.promptPlaceholder")}
          onChange={(event) => onPromptChange(event.target.value)}
        />
        <p className="text-xs text-white/45">{t("ai.billingNotice")}</p>
      </section>

      {error ? (
        <p
          role="alert"
          data-testid="workbench-ai-error"
          className={cn("text-xs", error.retryable ? "text-amber-300/90" : "text-red-300/90")}
        >
          {error.message}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={running || prompt.trim().length === 0 || (regionMode && !hasSelection)}
          onClick={onRun}
        >
          {running ? t("ai.running") : error?.retryable ? t("ai.retry") : t("ai.generate")}
        </Button>
        {running ? (
          <Button size="sm" variant="ghost" onClick={ai.cancel}>
            {t("ai.cancel")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={running}
          onClick={() => void ai.run({ kind: "remove-background" })}
        >
          {t("ai.removeBackground")}
        </Button>
      </div>
    </div>
  )
}
