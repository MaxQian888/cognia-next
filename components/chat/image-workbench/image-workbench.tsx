"use client"

/**
 * The image workbench: one surface for viewing, editing and versioning an
 * image that is already in a conversation.
 *
 * It replaces the read-only lightbox rather than sitting beside it, so a click
 * on any image in a message lands here. Viewing is still the default and still
 * costs nothing: the tools are opt-in, and the stage stays a plain zoomable
 * picture until one is picked.
 *
 * Everything stateful lives in `useImageWorkbench`. This component owns only
 * what the user is currently pointing at: which tool is open, the in-progress
 * crop rect, the unsent prompt, the brush settings.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CropIcon,
  EyeIcon,
  RedoIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UndoIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useImageWorkbench, type ImageWorkbenchSource } from "@/hooks/chat/use-image-workbench"
import type { CropRect, ImageAdjustments, MaskStroke } from "@/lib/images"
import { NEUTRAL_ADJUSTMENTS } from "@/lib/images"
import { cn } from "@/lib/utils"

import { WorkbenchStage, type StageMode } from "./workbench-stage"
import { AdjustPanel, AiPanel, TransformPanel } from "./workbench-panels"
import { VersionRail, type VersionRailItem } from "./version-rail"

type ToolId = "view" | "transform" | "adjust" | "ai"

export interface ImageWorkbenchProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: ImageWorkbenchSource | null
  target: { sessionId: string; messageId: string; canSave: boolean }
  /** Why saving is unavailable, when it is. Shown instead of hiding the button. */
  saveBlockedReason?: "streaming" | "read-only" | null
  rail: readonly VersionRailItem[]
  onSelectVersion: (url: string) => void
  canGoPrevious: boolean
  canGoNext: boolean
  onPrevious: () => void
  onNext: () => void
  onDownload: () => void
  title: string
}

const TOOL_MODE: Record<ToolId, StageMode> = {
  view: "view",
  transform: "crop",
  adjust: "view",
  ai: "view",
}

export function ImageWorkbench({
  open,
  onOpenChange,
  source,
  target,
  saveBlockedReason,
  rail,
  onSelectVersion,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  onDownload,
  title,
}: ImageWorkbenchProps) {
  const t = useTranslations("chat.imageWorkbench")
  const workbench = useImageWorkbench({ source, target, enabled: open })

  const [tool, setTool] = useState<ToolId>("view")
  const [zoom, setZoom] = useState(1)
  const [showOriginal, setShowOriginal] = useState(false)
  const [cropRect, setCropRect] = useState<CropRect | null>(null)
  const [aspectId, setAspectId] = useState("free")
  const [lockAspect, setLockAspect] = useState(true)
  const [adjustments, setAdjustments] = useState<ImageAdjustments>(NEUTRAL_ADJUSTMENTS)
  const [gestureId, setGestureId] = useState(() => `g_${Date.now()}`)
  const [prompt, setPrompt] = useState("")
  const [regionMode, setRegionMode] = useState(false)
  const [strokes, setStrokes] = useState<MaskStroke[]>([])
  const [brush, setBrush] = useState<{
    radius: number
    hardness: number
    mode: "add" | "subtract"
  }>({ radius: 32, hardness: 0.8, mode: "add" })
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const stageMode: StageMode = tool === "ai" && regionMode ? "brush" : TOOL_MODE[tool]

  const applyAdjustments = useCallback(
    (next: ImageAdjustments) => {
      setAdjustments(next)
      // One gesture id per continuous drag, so the reducer collapses the whole
      // drag into a single undo step instead of one per pixel of travel.
      workbench.apply({ kind: "adjust", adjustments: next, gestureId })
    },
    [gestureId, workbench]
  )

  const resetAdjustments = useCallback(() => {
    setAdjustments(NEUTRAL_ADJUSTMENTS)
    setGestureId(`g_${Date.now()}`)
    workbench.apply({ kind: "adjust", adjustments: NEUTRAL_ADJUSTMENTS, gestureId })
  }, [gestureId, workbench])

  const runAi = useCallback(() => {
    if (regionMode && strokes.length > 0) {
      void workbench.ai.runRegion(prompt, strokes).then(() => setStrokes([]))
      return
    }
    void workbench.ai.run({ kind: "prompt", prompt })
  }, [prompt, regionMode, strokes, workbench])

  const requestClose = useCallback(() => {
    if (workbench.isDirty && !confirmingDiscard) {
      setConfirmingDiscard(true)
      return
    }
    setConfirmingDiscard(false)
    onOpenChange(false)
  }, [confirmingDiscard, onOpenChange, workbench.isDirty])

  const saveDisabledReason = useMemo(() => {
    if (saveBlockedReason === "streaming") return t("save.blockedStreaming")
    if (saveBlockedReason === "read-only") return t("save.blockedReadOnly")
    if (workbench.blocked === "cors") return t("blocked.cors")
    return null
  }, [saveBlockedReason, t, workbench.blocked])

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent
        className="h-[min(94dvh,940px)] w-[min(96vw,1500px)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden border-0 bg-black p-0 shadow-2xl"
        showCloseButton={false}
      >
        <DialogHeader className="flex-row items-center gap-2 border-b border-white/10 bg-black/60 px-3 py-2 text-left">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-white">
            {title}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("dialogDescription")}</DialogDescription>

          <div className="flex shrink-0 items-center gap-0.5">
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
              disabled={zoom <= 0.5}
              aria-label={t("zoomOut")}
              tooltip={t("zoomOut")}
            >
              <ZoomOutIcon className="size-4" />
            </TooltipIconButton>
            <span className="min-w-12 px-1 text-center text-xs tabular-nums text-white/80">
              {Math.round(zoom * 100)}%
            </span>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
              disabled={zoom >= 3}
              aria-label={t("zoomIn")}
              tooltip={t("zoomIn")}
            >
              <ZoomInIcon className="size-4" />
            </TooltipIconButton>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              onPointerDown={() => setShowOriginal(true)}
              onPointerUp={() => setShowOriginal(false)}
              onPointerLeave={() => setShowOriginal(false)}
              aria-label={t("compare")}
              tooltip={t("compareHint")}
            >
              <EyeIcon className="size-4" />
            </TooltipIconButton>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              onClick={workbench.undo}
              disabled={!workbench.canUndo}
              aria-label={t("undo")}
              tooltip={t("undo")}
            >
              <UndoIcon className="size-4" />
            </TooltipIconButton>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              onClick={workbench.redo}
              disabled={!workbench.canRedo}
              aria-label={t("redo")}
              tooltip={t("redo")}
            >
              <RedoIcon className="size-4" />
            </TooltipIconButton>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              onClick={workbench.reset}
              disabled={!workbench.isDirty}
              aria-label={t("resetAll")}
              tooltip={t("resetAll")}
            >
              <RotateCcwIcon className="size-4" />
            </TooltipIconButton>

            <Button
              size="sm"
              variant="ghost"
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={onDownload}
            >
              {t("download")}
            </Button>

            <Button
              size="sm"
              disabled={!workbench.isDirty || workbench.save.saving || Boolean(saveDisabledReason)}
              title={saveDisabledReason ?? undefined}
              onClick={() => void workbench.save.run()}
              data-testid="workbench-save"
            >
              {workbench.save.saving ? t("save.saving") : t("save.save")}
            </Button>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              onClick={requestClose}
              aria-label={t("close")}
              tooltip={t("close")}
            >
              <XIcon className="size-4" />
            </TooltipIconButton>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-col lg:flex-row">
          <VersionRail
            items={rail}
            activeUrl={source?.url ?? null}
            onSelect={onSelectVersion}
            draftLabel={workbench.isDirty ? t("rail.unsaved") : null}
          />

          <div className="relative flex min-h-0 flex-1 flex-col">
            <WorkbenchStage
              previewUrl={workbench.previewUrl}
              originalUrl={workbench.originalUrl}
              size={workbench.size}
              zoom={zoom}
              mode={stageMode}
              showOriginal={showOriginal}
              cropRect={cropRect}
              onCropRectChange={setCropRect}
              brush={brush}
              strokes={strokes}
              onStrokesChange={setStrokes}
              onDoubleClick={() => setZoom((value) => (value === 1 ? 2 : 1))}
            />

            {canGoPrevious ? (
              <TooltipIconButton
                variant="secondary"
                size="icon"
                className="absolute left-2 top-1/2 size-10 -translate-y-1/2 rounded-full bg-black/45 text-white backdrop-blur-sm hover:bg-black/65"
                onClick={onPrevious}
                aria-label={t("previous")}
                tooltip={t("previous")}
              >
                <ChevronLeftIcon className="size-5" />
              </TooltipIconButton>
            ) : null}
            {canGoNext ? (
              <TooltipIconButton
                variant="secondary"
                size="icon"
                className="absolute right-2 top-1/2 size-10 -translate-y-1/2 rounded-full bg-black/45 text-white backdrop-blur-sm hover:bg-black/65"
                onClick={onNext}
                aria-label={t("next")}
                tooltip={t("next")}
              >
                <ChevronRightIcon className="size-5" />
              </TooltipIconButton>
            ) : null}

            {workbench.blocked ? (
              <div
                role="status"
                data-testid="workbench-blocked"
                className="absolute inset-x-0 bottom-0 border-t border-white/10 bg-black/85 px-4 py-2 text-xs text-white/80"
              >
                {t(`blocked.${workbench.blocked}`)}
              </div>
            ) : null}
          </div>

          {/*
            A right column on a wide window and a bottom sheet below it. One
            tree either way: duplicating it would mean duplicating the draft
            state, and the crop a user started on a phone would vanish when the
            window widened.
          */}
          <aside
            data-testid="workbench-panel"
            className={cn(
              "flex shrink-0 flex-col gap-3 overflow-y-auto border-white/10 bg-black/80 p-3 text-white",
              "max-h-[45dvh] border-t lg:max-h-none lg:w-80 lg:border-l lg:border-t-0"
            )}
          >
            <div className="flex gap-1" role="tablist" aria-label={t("toolsLabel")}>
              {(
                [
                  ["view", EyeIcon],
                  ["transform", CropIcon],
                  ["adjust", SlidersHorizontalIcon],
                  ["ai", SparklesIcon],
                ] as const
              ).map(([id, Icon]) => (
                <Button
                  key={id}
                  role="tab"
                  aria-selected={tool === id}
                  size="sm"
                  variant={tool === id ? "secondary" : "ghost"}
                  className="min-w-0 shrink gap-1.5 text-xs"
                  onClick={() => setTool(id)}
                >
                  <Icon className="size-3.5" />
                  {t(`tools.${id}`)}
                </Button>
              ))}
            </div>

            {tool === "view" ? (
              <p className="text-xs text-white/55" data-testid="workbench-view-hint">
                {workbench.size
                  ? t("viewHint", { width: workbench.size.width, height: workbench.size.height })
                  : t("viewHintLoading")}
              </p>
            ) : null}

            {tool === "transform" ? (
              <TransformPanel
                size={workbench.size}
                cropRect={cropRect}
                onCropRectChange={setCropRect}
                aspectId={aspectId}
                onAspectChange={setAspectId}
                onApplyCrop={(rect) => {
                  workbench.apply({ kind: "crop", rect })
                  setCropRect(null)
                }}
                onResize={(width, height) => workbench.apply({ kind: "resize", width, height })}
                onRotate={(turns) => workbench.apply({ kind: "rotate", turns })}
                onFlip={(axis) =>
                  workbench.apply({
                    kind: "flip",
                    horizontal: axis === "horizontal",
                    vertical: axis === "vertical",
                  })
                }
                lockAspect={lockAspect}
                onLockAspectChange={setLockAspect}
              />
            ) : null}

            {tool === "adjust" ? (
              <AdjustPanel
                adjustments={adjustments}
                onChange={applyAdjustments}
                onReset={resetAdjustments}
              />
            ) : null}

            {tool === "ai" ? (
              <AiPanel
                ai={workbench.ai}
                prompt={prompt}
                onPromptChange={setPrompt}
                regionMode={regionMode}
                onRegionModeChange={setRegionMode}
                brush={brush}
                onBrushChange={setBrush}
                hasSelection={strokes.length > 0}
                onClearSelection={() => setStrokes([])}
                onRun={runAi}
              />
            ) : null}

            {workbench.save.error ? (
              <p
                role="alert"
                className="text-xs text-red-300/90"
                data-testid="workbench-save-error"
              >
                {workbench.save.error}
              </p>
            ) : null}
            {saveDisabledReason ? (
              <p className="text-xs text-white/55" data-testid="workbench-save-blocked">
                {saveDisabledReason}
              </p>
            ) : null}

            {confirmingDiscard ? (
              <div
                role="alertdialog"
                aria-label={t("discard.title")}
                data-testid="workbench-discard"
                className="flex flex-col gap-2 rounded-lg border border-white/15 bg-white/5 p-3"
              >
                <p className="text-xs text-white/80">{t("discard.body")}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" onClick={() => onOpenChange(false)}>
                    {t("discard.confirm")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingDiscard(false)}>
                    {t("discard.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
