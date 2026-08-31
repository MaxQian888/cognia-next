"use client"

/**
 * The review sheet a generated result lands in before it touches the user's
 * document.
 *
 * It is the one surface in the toolbar that is read rather than clicked, so it
 * takes the denser tint from `selection-surface.tsx` while keeping the same
 * border, blur and elevation as the pill it grew out of.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import type { ExternalSelectionCandidate } from "@/lib/tauri/selection-toolbar"
import type { PluginQuickActionResult } from "@/types/plugin"
import { SELECTION_GLASS, SELECTION_SHEET_TINT } from "./selection-surface"
import type { SelectionToolbarGeometryHandles } from "./use-selection-toolbar-geometry"

type VisibleResult = Exclude<PluginQuickActionResult, void | { kind: "status"; message?: string }>

export interface SelectionResultPanelProps {
  candidate: ExternalSelectionCandidate
  result: VisibleResult
  attribution: string
  canReplace: boolean
  replaceUnavailableReason?: string
  undoAvailable?: boolean
  errorMessage?: string
  onCopy: (text: string) => void
  onOpen: (text: string) => void
  onReplace: (text: string) => void
  onCancel: () => void
  onUndo: () => void
}

export function SelectionResultPanelShell({
  geometry,
  children,
}: {
  geometry: SelectionToolbarGeometryHandles
  children: React.ReactNode
}) {
  const { shellRef, capsuleRef } = geometry
  return (
    <div ref={shellRef} className="flex w-max flex-col items-center">
      <div ref={capsuleRef}>{children}</div>
    </div>
  )
}

export function SelectionResultPanel({
  candidate,
  result,
  attribution,
  canReplace,
  replaceUnavailableReason,
  undoAvailable = false,
  errorMessage,
  onCopy,
  onOpen,
  onReplace,
  onCancel,
  onUndo,
}: SelectionResultPanelProps) {
  const t = useTranslations("selectionToolbar.result")
  const variants = useMemo(
    () => (result.kind === "variants" ? result.variants : [result.text]),
    [result]
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selected = variants[selectedIndex] ?? variants[0]

  return (
    <Surface asChild layer="overlay" radius="stage" elevation={3}>
      <section
        style={SELECTION_SHEET_TINT}
        className={cn(
          "pointer-events-auto flex max-h-[min(70vh,520px)] w-[min(92vw,520px)] flex-col gap-3 overflow-hidden p-3",
          SELECTION_GLASS
        )}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("title")}</p>
            {/*
              One line, two elements. Each half stays its own node so it is
              addressable on its own, and the separator is decorative, so a
              screen reader reads two facts rather than one run-on sentence.
            */}
            <p className="truncate text-[11px] text-muted-foreground">
              <span>{t("attribution", { name: attribution })}</span>
              <span aria-hidden> · </span>
              <span>{t("source", { name: candidate.sourceApp })}</span>
            </p>
          </div>
          {/*
            `rounded-pill`, not `rounded-full`. A padded capsule follows the
            style pack (ADR-0148), and `components/surface/pill-radius.test.ts`
            fails the build on the pairing this line used to carry.
          */}
          <span className="shrink-0 rounded-pill bg-warning/10 px-2 py-1 text-[10px] leading-tight text-warning">
            {t(`sourceWarning.${candidate.origin}` as never)}
          </span>
        </header>

        {variants.length > 1 ? (
          <div className="flex flex-wrap gap-1" role="list" aria-label={t("variants")}>
            {variants.map((variant, index) => (
              <Button
                key={`${index}:${variant.slice(0, 16)}`}
                type="button"
                size="sm"
                variant={selectedIndex === index ? "secondary" : "ghost"}
                onClick={() => setSelectedIndex(index)}
                aria-label={variant}
                aria-pressed={selectedIndex === index}
              >
                {selectedIndex === index ? <CheckIcon className="size-3" /> : null}
                {t("variant", { index: index + 1 })}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="grid min-h-0 gap-2 sm:grid-cols-2">
          <ComparisonBlock label={t("original")} text={candidate.text} muted />
          <ComparisonBlock label={t("result")} text={selected} />
        </div>

        {!canReplace && replaceUnavailableReason ? (
          <p className="text-[11px] text-muted-foreground">
            {t(replaceUnavailableReason as never)}
          </p>
        ) : null}
        {errorMessage ? (
          <p role="alert" className="text-[11px] text-destructive">
            {errorMessage}
          </p>
        ) : null}

        {/*
          Ordered by weight, left to right, so the destructive-adjacent button
          is never the one under a returning pointer: leave, then the two that
          only move text around, then the one that edits the user's document.
        */}
        <footer className="flex flex-wrap items-center justify-end gap-2">
          {undoAvailable ? (
            <Button type="button" size="sm" variant="outline" onClick={onUndo} className="mr-auto">
              <RotateCcwIcon className="size-3.5" />
              {t("undo")}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onCopy(selected)}>
            {t("copyResult")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpen(selected)}>
            {t("openInCognia")}
          </Button>
          {canReplace ? (
            <Button type="button" size="sm" onClick={() => onReplace(selected)}>
              {t("replace")}
            </Button>
          ) : null}
        </footer>
      </section>
    </Surface>
  )
}

function ComparisonBlock({
  label,
  text,
  muted = false,
}: {
  label: string
  text: string
  muted?: boolean
}) {
  // A plain box rather than a `Surface`. Surface paints `bg-[var(--surface-bg)]`,
  // an arbitrary value, and Tailwind sorts those after named utilities, so the
  // tier tint would quietly beat the recessed fill these two blocks want.
  return (
    <div className="min-h-0 rounded-panel border bg-background/70 p-2">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div
        className={cn(
          "max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed",
          muted && "text-muted-foreground"
        )}
      >
        {text}
      </div>
    </div>
  )
}

export default SelectionResultPanel
